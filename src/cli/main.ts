#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AgentInvoker } from '../agents/provider.js';
import {
  askQuestions,
  generatePlan,
  planPrompt,
  plannerAgent,
  PlanGenerationError,
  type Answer,
} from '../plan/generate.js';
import { ensureStateDir, isStatePath, repoRelative } from '../state/dir.js';
import { ArtifactStore } from '../state/artifacts.js';
import { Redactor } from '../state/redact.js';
import { acquireLock, LockError } from '../state/lock.js';
import { createRenderer } from './render.js';
import { notify, type NotifyEvent, type NotifyPayload } from './notify.js';
import { watchRun } from './watch.js';
import { generateSpec, readSpec, writeSpec, PRD_PATH, SPEC_PATH } from '../spec/spec.js';
import { renderBoardPlain } from '../board/board.js';
import { runDoctor } from '../doctor/doctor.js';
import { renderReport } from '../doctor/render.js';
import { ConfigError, loadConfig, loadPlan } from '../config/load.js';
import { Runner } from '../runner/runner.js';
import { StateStore, makeRunId, readRunRecord } from '../state/store.js';
import { StateError, remedyFor } from '../state/schema.js';
import type { RunRecord } from '../types.js';
import { Journal } from '../journal/journal.js';
import { topoOrder } from '../plan/schema.js';
import { AUTONOMY_CONTRACT } from '../prompts/contract.js';
import { writeStarterFiles } from '../config/init.js';
import * as git from '../git/git.js';

const program = new Command();

program
  .name('kalfa')
  .description('Unattended, gate-driven build runner. One agent writes, another reviews.')
  .version('0.1.0');

function fail(message: string): never {
  process.stderr.write(`kalfa: ${message}\n`);
  process.exit(1);
}

/**
 * Run state, or an exit with the reason and the fix.
 *
 * State that exists but cannot be read is not the same as no state, and the
 * one thing the CLI must never do with the difference is shrug: a run that
 * silently restarts pays again for every task it already finished.
 */
function readRunOrFail(cwd: string): RunRecord | undefined {
  try {
    return readRunRecord(cwd);
  } catch (err) {
    if (err instanceof StateError) fail(`${err.message}\n  ${remedyFor(err.problem)}`);
    throw err;
  }
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const usd = (n: number): string => `$${n.toFixed(4)}`;

/**
 * Preflight: everything that must be true before an unattended run starts.
 *
 * The dirty-tree rule is relaxed when resuming. A run killed mid-task leaves
 * that task's work in the tree by design — the retry prompt tells the worker
 * to go and read it — so refusing would strand the user at exactly the moment
 * resume exists for. It is reported rather than silently accepted.
 *
 * Kalfa's own state directory is claimed before the check, not after. The
 * documented detached launch redirects stdout into `.kalfa/run.log`, which
 * creates the directory — and its first two files — before Kalfa has ever run
 * in that repository. A first real-project run died exactly there: `?? .kalfa/
 * run.err`, reported as the user's uncommitted work, no task started. Kalfa's
 * own operator logs are not the user's dirty tree, and it should never have
 * been the operator's job to know that.
 */
class PreflightError extends Error {}

function preflight(cwd: string, resuming = false): void {
  const refuse = (message: string): never => {
    throw new PreflightError(message);
  };
  if (!git.isRepo(cwd)) refuse('not a git repository — kalfa relies on git for commits and rollback');
  if (!git.hasCommits(cwd)) {
    refuse('this repository has no commits yet — make an initial commit first');
  }
  ensureStateDir(cwd);

  // Filtered as well as ignored. The gitignore handles every normal case; a
  // `.kalfa/` path that was committed before the ignore file existed stays
  // tracked forever, and that must not be able to strand a run either.
  const lines = git.statusLines(cwd).filter((line) => !isStatePath(line.slice(3).trim()));
  if (lines.length === 0) return;

  if (!resuming) {
    refuse(
      `working tree is dirty — commit or stash first, so kalfa can tell its own work from yours:\n` +
        lines.slice(0, 10).map((l) => `  ${l}`).join('\n'),
    );
  }
  process.stdout.write(
    `resuming with uncommitted work in the tree — treating it as the interrupted task's:\n` +
      lines.slice(0, 10).map((l) => `  ${l}\n`).join('') +
      `\n`,
  );
}

program
  .command('init')
  .description('Write a starter kalfa.yaml, kalfa.plan.json, and the agent skill')
  .option('-f, --force', 'overwrite existing files')
  .action((opts: { force?: boolean }) => {
    for (const file of writeStarterFiles(process.cwd(), opts.force)) {
      process.stdout.write(
        file.written
          ? `wrote ${file.path}\n`
          : `skipped ${file.path} (exists — pass --force to overwrite)\n`,
      );
    }
    process.stdout.write(
      '\nThe SKILL.md files let Claude Code and Codex drive kalfa for you: ask either\n' +
        'one to build something with kalfa and it will spec, plan and run it. Commit\n' +
        'them, so a teammate’s agent finds them too.\n\n' +
        'Next: edit kalfa.plan.json into real tasks, then `kalfa validate` and `kalfa run`.\n' +
        'Or skip the hand-editing: `kalfa spec "<what you want built>"`.\n',
    );
  });

program
  .command('validate')
  .description('Check the config and plan without running anything')
  .option('-c, --config <path>', 'config file')
  .option('-p, --plan <path>', 'plan file', 'kalfa.plan.json')
  .action((opts: { config?: string; plan: string }) => {
    const cwd = process.cwd();
    try {
      const { config, path } = loadConfig(cwd, opts.config);
      const { plan, path: planPath } = loadPlan(cwd, opts.plan);
      const ordered = topoOrder(plan);

      process.stdout.write(`config  ${path}\n`);
      process.stdout.write(`  builder   ${config.agents.builder.provider}`);
      process.stdout.write(config.agents.builder.model ? ` (${config.agents.builder.model})\n` : '\n');
      // Observed in a real run: with acceptEdits the builder made its edit,
      // was denied Bash, and ended with "I need your approval to run
      // node check.mjs" — reported as a successful run, work unverified.
      if (
        config.agents.builder.provider === 'claude' &&
        config.agents.builder.permission_mode === 'acceptEdits' &&
        !config.agents.builder.allowed_tools?.some((t) => t.startsWith('Bash'))
      ) {
        process.stdout.write(
          `  warning:  builder uses permission_mode acceptEdits, which auto-approves\n` +
            `            edits but NOT Bash. Unattended, it will stop and ask for approval\n` +
            `            before it can run your tests, and report that as a finished task.\n` +
            `            Use bypassPermissions, or list Bash in allowed_tools.\n`,
        );
      }
      if (config.agents.reviewer) {
        process.stdout.write(`  reviewer  ${config.agents.reviewer.provider}`);
        process.stdout.write(
          config.agents.reviewer.model ? ` (${config.agents.reviewer.model})\n` : '\n',
        );
        if (config.agents.reviewer.provider === config.agents.builder.provider) {
          process.stdout.write(
            `  warning:  builder and reviewer are the same provider — a model is a weak\n` +
              `            reviewer of its own output. Prefer a different vendor.\n`,
          );
        }
      } else {
        process.stdout.write(`  reviewer  (none — review disabled)\n`);
      }
      process.stdout.write(`  gates     ${config.gates.map((g) => g.name).join(', ') || '(none)'}\n`);
      process.stdout.write(
        `  protected ${
          config.policy.protected_paths.length > 0
            ? `${config.policy.protected_paths.length} pattern(s) — test changes get flagged`
            : '(none — a task can rewrite your tests unremarked)'
        }\n`,
      );
      if (config.gates.length === 0) {
        process.stdout.write(
          `  warning:  no gates configured. Without machine checks, nothing verifies\n` +
            `            the work but the reviewer. Add at least a typecheck and tests.\n`,
        );
      }
      process.stdout.write(
        `  evidence  ${
          config.observability.artifacts
            ? `per-attempt artifacts under .kalfa/runs/<run-id>/${
                config.observability.capture_prompts ? ' (prompts captured)' : ''
              }`
            : '(off — a blocking finding will not be checkable against the diff it was about)'
        }\n`,
      );
      process.stdout.write(
        `  notify    ${
          config.notify.command
            ? `on ${config.notify.on.join(', ')} — ${config.notify.command.slice(0, 60)}`
            : '(none — you will have to watch with `kalfa status --watch`)'
        }\n`,
      );

      process.stdout.write(`\nplan    ${planPath}\n`);
      process.stdout.write(`  goal      ${plan.goal}\n`);
      process.stdout.write(`  tasks     ${plan.tasks.length}, execution order:\n`);
      for (const [i, task] of ordered.entries()) {
        const deps = task.deps.length > 0 ? `  <- ${task.deps.join(', ')}` : '';
        process.stdout.write(`    ${String(i + 1).padStart(2)}. ${task.id}: ${task.title}${deps}\n`);
      }
      process.stdout.write('\nok\n');
    } catch (err) {
      if (err instanceof ConfigError) fail(err.message);
      throw err;
    }
  });

program
  .command('contract')
  .description('Print the autonomy contract handed to every agent')
  .action(() => {
    process.stdout.write(`${AUTONOMY_CONTRACT}\n`);
  });

program
  .command('doctor')
  .description('Check that this repository and machine are ready for a run')
  .option('-c, --config <path>', 'config file')
  .option('-p, --plan <path>', 'plan file', 'kalfa.plan.json')
  .option('--json', 'machine-readable output')
  .action(async (opts: { config?: string; plan: string; json?: boolean }) => {
    // Every check here exists because something actually went wrong: a missing
    // CLI, a permission mode that silently cannot run tests, a dirty tree, a
    // gate command that is not on PATH. Cheap to run, and it runs nothing of
    // yours — no gates are executed, no prompts are sent, no money is spent.
    //
    // The state directory is claimed first, for the same reason `run` does it:
    // doctor's clean-tree check would otherwise report Kalfa's own operator
    // logs as the user's uncommitted work, and send them to fix nothing.
    if (git.isRepo(process.cwd())) ensureStateDir(process.cwd());

    const report = await runDoctor({
      cwd: process.cwd(),
      ...(opts.config ? { configPath: opts.config } : {}),
      ...(opts.plan ? { planPath: opts.plan } : {}),
    });

    process.stdout.write(
      opts.json ? `${JSON.stringify(report, null, 2)}
` : `${renderReport(report)}
`,
    );
    if (!report.ok) process.exitCode = 1;
  });

program
  .command('status')
  .description('Where the current run got to')
  .option('-p, --plan <path>', 'plan file', 'kalfa.plan.json')
  .option('--json', 'machine-readable output')
  .option(
    '-w, --watch',
    'follow the run until it finishes; exits 0 clean, 2 needs you, 3 the run died',
  )
  .option('--interval <ms>', 'how often --watch checks for new events', '1000')
  .action(async (opts: { plan: string; json?: boolean; watch?: boolean; interval: string }) => {
    const cwd = process.cwd();

    if (opts.watch) {
      // Costs nothing and calls nothing: it reads local files and sleeps.
      let plan;
      try {
        ({ plan } = loadPlan(cwd, opts.plan));
      } catch {
        // A board needs the plan; transitions do not. Watching without one is
        // better than refusing to watch.
      }
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      const code = await watchRun({
        cwd,
        ...(plan ? { plan } : {}),
        json: Boolean(opts.json),
        tty: Boolean(process.stdout.isTTY),
        pollMs: Math.max(100, Number(opts.interval) || 1000),
        signal: controller.signal,
      });
      process.exitCode = code;
      return;
    }

    const run = readRunOrFail(cwd);
    if (!run) fail('no run state found — nothing has been run in this repository yet');

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      return;
    }

    let plan;
    try {
      ({ plan } = loadPlan(cwd, opts.plan));
    } catch {
      fail(`run ${run.runId} exists but ${opts.plan} could not be read — pass --plan`);
    }

    const counts = { done: 0, blocked: 0, skipped: 0, running: 0, pending: 0 };
    for (const task of plan.tasks) {
      counts[run.tasks[task.id]?.status ?? 'pending'] += 1;
    }
    const cost = Object.values(run.tasks).reduce((sum, t) => sum + t.costUsd, 0);

    process.stdout.write(`run ${run.runId}`);
    if (run.branch) process.stdout.write(`  branch ${run.branch}`);
    process.stdout.write(run.finishedAt ? `  finished\n` : `  in progress\n`);
    process.stdout.write(`${plan.goal}\n\n`);
    process.stdout.write(`${renderBoardPlain(plan, run)}\n\n`);
    process.stdout.write(
      `${counts.done}/${plan.tasks.length} done` +
        (counts.blocked > 0 ? `, ${counts.blocked} blocked` : '') +
        (counts.skipped > 0 ? `, ${counts.skipped} skipped` : '') +
        `  ·  ${usd(cost)}${run.costIncomplete ? '+' : ''}\n`,
    );
    if (run.costIncomplete) {
      process.stdout.write(`cost is a floor — codex does not report its spend\n`);
    }
    const withTests = plan.tasks.filter((t) => (run.tasks[t.id]?.protectedPaths ?? []).length > 0);
    if (withTests.length > 0) {
      process.stdout.write(
        `\n${withTests.length} task(s) modified tests or checks — read those diffs first:\n`,
      );
      for (const task of withTests) {
        process.stdout.write(`  ${task.id}  ${(run.tasks[task.id]?.protectedPaths ?? []).join(', ')}\n`);
      }
    }
    if (run.runDir) {
      process.stdout.write(`\nfull evidence per attempt in ${run.runDir}/artifacts/\n`);
    }
    if (!run.finishedAt) {
      process.stdout.write(`follow it with: kalfa status --watch\n`);
    }
    if (counts.blocked + counts.skipped + counts.pending > 0) {
      process.stdout.write(`\nresume with: kalfa run --run-id ${run.runId}\n`);
      process.stdout.write(`details in TASKS.md and BLOCKED.md\n`);
    }
  });

program
  .command('spec')
  .argument('<goal>', 'what you want built, in a sentence or two')
  .description('Write docs/PRD.md and docs/SPEC.md by inspecting this repository')
  .option('-m, --model <model>', 'model for the planner')
  .option('--no-interview', 'skip the questions')
  .option('-q, --questions <n>', 'maximum questions to ask', '6')
  .option('-f, --force', 'overwrite existing documents')
  .action(async (goal: string, opts: SpecOptions) => {
    const cwd = process.cwd();
    if (!git.isRepo(cwd)) fail('not a git repository — spec from inside the repo you want built');

    for (const rel of [PRD_PATH, SPEC_PATH]) {
      if (existsSync(resolve(cwd, rel)) && !opts.force) {
        fail(`${rel} already exists — pass --force to overwrite it`);
      }
    }

    const planner = new AgentInvoker(plannerAgent(opts.model));
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());

    let costUsd = 0;
    const answers = await runInterview(
      planner,
      goal,
      cwd,
      opts.interview,
      Number(opts.questions) || 6,
      controller.signal,
      (spent) => (costUsd += spent),
    );

    process.stdout.write('writing the specification...\n');
    try {
      const result = await generateSpec(planner, {
        goal,
        cwd,
        answers,
        signal: controller.signal,
        onAttempt: (attempt, problems) => {
          if (attempt > 1) {
            process.stdout.write(`  attempt ${attempt} — previous draft rejected:\n`);
            for (const line of (problems ?? '').split('\n').slice(0, 4)) {
              process.stdout.write(`    ${line}\n`);
            }
          }
        },
      });
      costUsd += result.costUsd;
      const written = writeSpec(cwd, result.docs);

      process.stdout.write(`\nwrote ${written.prd} and ${written.spec} — ${usd(costUsd)}\n\n`);
      process.stdout.write(
        `Read SPEC.md, and pay attention to its Non-goals section — that is what\n` +
          `stops an unattended agent building things nobody asked for.\n\n` +
          `Then: kalfa plan\n`,
      );
    } catch (err) {
      if (err instanceof PlanGenerationError) fail(err.message);
      throw err;
    }
  });

interface SpecOptions {
  model?: string;
  interview: boolean;
  questions: string;
  force?: boolean;
}

/**
 * The single interactive moment, shared by `spec` and `plan`: every question
 * at once, each with a default, then never again.
 */
async function runInterview(
  planner: AgentInvoker,
  goal: string,
  cwd: string,
  enabled: boolean,
  maxQuestions: number,
  signal: AbortSignal,
  spend: (costUsd: number) => void,
): Promise<Answer[]> {
  if (!enabled) return [];

  process.stdout.write('reading the repository...\n');
  const asked = await askQuestions(planner, goal, cwd, maxQuestions, signal);
  spend(asked.costUsd);

  if (asked.questions.length === 0) {
    process.stdout.write('no questions — the repository and goal were clear enough.\n\n');
    return [];
  }

  process.stdout.write(
    `\n${asked.questions.length} question${asked.questions.length === 1 ? '' : 's'}. ` +
      `Press Enter to accept the suggested answer.\nThis is the only time you will be asked.\n\n`,
  );

  const answers: Answer[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [i, q] of asked.questions.entries()) {
      process.stdout.write(`${i + 1}. ${q.question}\n`);
      if (q.why) process.stdout.write(`   why: ${q.why}\n`);
      const reply = (await rl.question(`   [${q.suggested}] > `)).trim();
      answers.push({
        question: q.question,
        answer: reply || q.suggested,
        defaulted: reply.length === 0,
      });
      process.stdout.write('\n');
    }
  } finally {
    rl.close();
  }
  return answers;
}

program
  .command('plan')
  .argument('[goal]', 'what the run should accomplish; optional once docs/SPEC.md exists')
  .description('Generate a validated kalfa.plan.json by inspecting this repository')
  .option('-o, --out <path>', 'where to write the plan', 'kalfa.plan.json')
  .option('-m, --model <model>', 'model for the planner')
  .option('--no-interview', 'skip the questions and generate straight from the goal')
  .option('-q, --questions <n>', 'maximum questions to ask', '6')
  .option('-f, --force', 'overwrite an existing plan file')
  .option('--print-prompt', 'print the planning prompt and exit — no API call')
  .action(async (goalArg: string | undefined, opts: PlanOptions) => {
    const cwd = process.cwd();
    const outPath = resolve(cwd, opts.out);
    const spec = readSpec(cwd);

    // With a spec on disk the goal line is optional: the spec is the real
    // source of truth, and repeating it on the command line invites drift.
    const goal = goalArg ?? (spec ? `See ${SPEC_PATH} — it is authoritative.` : undefined);
    if (!goal) {
      fail(
        `no goal given and no ${SPEC_PATH} to plan from.\n` +
          `  write one:  kalfa spec "<what you want built>"\n` +
          `  or pass a goal:  kalfa plan "<goal>"`,
      );
    }

    if (opts.printPrompt) {
      process.stdout.write(`${planPrompt(goal, [], undefined, spec)}\n`);
      return;
    }
    if (existsSync(outPath) && !opts.force) {
      fail(`${opts.out} already exists — pass --force to overwrite it`);
    }
    if (!git.isRepo(cwd)) fail('not a git repository — plan from inside the repo you want built');

    const planner = new AgentInvoker(plannerAgent(opts.model));
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());

    let costUsd = 0;
    if (spec) process.stdout.write(`planning from ${SPEC_PATH}\n`);

    // A spec has already been through the interview; asking again is asking
    // twice for the same information.
    const answers = await runInterview(
      planner,
      goal,
      cwd,
      opts.interview && !spec,
      Number(opts.questions) || 6,
      controller.signal,
      (spent) => (costUsd += spent),
    );

    process.stdout.write('writing the plan...\n');
    try {
      const result = await generatePlan(planner, {
        goal,
        cwd,
        answers,
        ...(spec ? { spec } : {}),
        signal: controller.signal,
        onAttempt: (attempt, errors) => {
          if (attempt > 1) {
            process.stdout.write(`  attempt ${attempt} — previous plan failed validation:\n`);
            for (const line of (errors ?? '').split('\n').slice(0, 5)) {
              process.stdout.write(`    ${line}\n`);
            }
          }
        },
      });
      costUsd += result.costUsd;

      writeFileSync(outPath, `${JSON.stringify(result.plan, null, 2)}\n`, 'utf8');

      process.stdout.write(`\nwrote ${opts.out} — ${result.plan.tasks.length} tasks, ${usd(costUsd)}\n\n`);
      for (const [i, task] of topoOrder(result.plan).entries()) {
        const deps = task.deps.length > 0 ? `  <- ${task.deps.join(', ')}` : '';
        process.stdout.write(`  ${String(i + 1).padStart(2)}. ${task.id}: ${task.title}${deps}\n`);
      }
      process.stdout.write(
        `\nRead it before running. Every vague \`details\` field becomes an\n` +
          `assumption recorded as an ADR that nobody will be awake to catch.\n` +
          `Then: kalfa run\n`,
      );
    } catch (err) {
      if (err instanceof PlanGenerationError) {
        process.stderr.write(`kalfa: ${err.message}\n`);
        if (err.lastOutput) {
          const scratch = resolve(cwd, '.kalfa', 'last-plan-attempt.txt');
          ensureStateDir(cwd);
          writeFileSync(scratch, err.lastOutput, 'utf8');
          process.stderr.write(`the planner's last output is in ${scratch}\n`);
        }
        process.exit(1);
      }
      throw err;
    }
  });

interface PlanOptions {
  out: string;
  model?: string;
  interview: boolean;
  questions: string;
  force?: boolean;
  printPrompt?: boolean;
}

program
  .command('run')
  .description('Run the plan unattended')
  .option('-c, --config <path>', 'config file')
  .option('-p, --plan <path>', 'plan file', 'kalfa.plan.json')
  .option('--run-id <id>', 'resume an existing run instead of starting a new one')
  .option('--dry-run', 'print the execution order and exit')
  .option('--force', 'take the run lock even if another run appears to hold it')
  .option('--new', 'start a fresh run even though an earlier one was interrupted')
  .option('-v, --verbose', 'print every command, tool call and gate line as it happens')
  .option('--jsonl', 'emit the structured event stream on stdout instead of prose')
  .option('--no-artifacts', 'do not persist per-attempt stdout, gate output or reviews')
  .action(async (opts: {
    config?: string;
    plan: string;
    runId?: string;
    dryRun?: boolean;
    force?: boolean;
    new?: boolean;
    verbose?: boolean;
    jsonl?: boolean;
    artifacts: boolean;
  }) => {
    const cwd = process.cwd();
    let config, plan, planPath;
    try {
      ({ config } = loadConfig(cwd, opts.config));
      ({ plan, path: planPath } = loadPlan(cwd, opts.plan));
    } catch (err) {
      if (err instanceof ConfigError) fail(err.message);
      throw err;
    }

    if (opts.dryRun) {
      for (const [i, task] of topoOrder(plan).entries()) {
        process.stdout.write(`${String(i + 1).padStart(2)}. ${task.id}: ${task.title}\n`);
      }
      return;
    }

    // An interrupted run is the common case for wanting to start again, and
    // starting a *new* one instead silently redoes work already paid for.
    const previous = readRunOrFail(cwd);
    const resuming = Boolean(opts.runId && previous?.runId === opts.runId);
    if (!opts.runId && !opts.new && previous && !previous.finishedAt) {
      const done = Object.values(previous.tasks).filter((t) => t.status === 'done').length;
      fail(
        `run ${previous.runId} was interrupted and never finished (${done} task(s) done).\n` +
          `  resume it:      kalfa run --run-id ${previous.runId}\n` +
          `  start over:     kalfa run --new\n` +
          `Starting a new run would redo work you have already paid for.`,
      );
    }
    if (!opts.runId && previous?.finishedAt) {
      const done = Object.values(previous.tasks).filter((t) => t.status === 'done').length;
      process.stdout.write(
        `note: run ${previous.runId} already completed ${done} task(s). This is a fresh run and will redo them.\n\n`,
      );
    }

    const runId = opts.runId ?? makeRunId();

    /**
     * Refuse to start, and tell whoever is not watching.
     *
     * A run is launched detached and its operator is asleep. A failure before
     * the first task is the case where silence costs the most: nothing is
     * running, nothing ever will be, and the only signal is a line in a log
     * file nobody is reading. This is the "run failed before task execution"
     * notification, and it fires before the process exits.
     */
    const refuseToStart = async (message: string): Promise<never> => {
      const warning = await notify(
        config.notify,
        {
          event: 'failed',
          runId,
          goal: plan.goal,
          error: message,
          paths: {
            tasks: 'TASKS.md',
            blocked: 'BLOCKED.md',
            journal: '.kalfa/journal.jsonl',
            adrs: 'docs/adr/README.md',
          },
        },
        cwd,
      );
      if (warning) process.stderr.write(`kalfa: ${warning}\n`);
      return fail(message);
    };

    try {
      preflight(cwd, resuming);
    } catch (err) {
      if (err instanceof PreflightError) await refuseToStart(err.message);
      throw err;
    }

    // One run per working tree. Two would interleave commits and clobber each
    // other's state, which is not a race to lose gracefully — it is data loss.
    let releaseLock: () => void;
    try {
      releaseLock = acquireLock(cwd, {
        runId,
        command: 'kalfa run',
        ...(opts.force ? { force: true } : {}),
      });
    } catch (err) {
      if (err instanceof LockError) await refuseToStart(err.message);
      throw err;
    }
    const release = (): void => releaseLock();
    process.once('exit', release);

    const redactor = new Redactor(config.observability.redact_patterns);
    const store = new StateStore(cwd, runId, planPath);
    const journal = new Journal(cwd, runId, '.kalfa', redactor);
    const keepArtifacts = config.observability.artifacts && opts.artifacts !== false;
    const artifacts = keepArtifacts ? new ArtifactStore(cwd, runId, redactor) : undefined;

    const controller = new AbortController();
    const onSignal = (): void => {
      process.stdout.write('\n\nstopping after the current step — press Ctrl-C again to kill\n');
      controller.abort();
      process.once('SIGINT', () => process.exit(130));
    };
    process.once('SIGINT', onSignal);

    const startedAt = Date.now();
    if (!opts.jsonl) {
      process.stdout.write(`kalfa run ${runId}\n${plan.goal}\n`);
      process.stdout.write(
        `events in ${repoRelative(cwd, journal.path)} · follow with: kalfa status --watch\n\n`,
      );
    }

    const render = createRenderer({
      verbose: Boolean(opts.verbose),
      jsonl: Boolean(opts.jsonl),
    });

    const runner = new Runner({
      cwd,
      config,
      plan,
      planPath,
      runId,
      store,
      journal,
      ...(artifacts ? { artifacts } : {}),
      signal: controller.signal,
      onEvent: render,
    });

    /** Terminal-state notification, fired once, on every way out of here. */
    const announce = async (event: NotifyEvent, extra: Partial<NotifyPayload> = {}): Promise<void> => {
      const warning = await notify(
        config.notify,
        {
          event,
          runId,
          ...(store.run.branch ? { branch: store.run.branch } : {}),
          goal: plan.goal,
          counts: store.counts(),
          costUsd: store.totalCostUsd(),
          ...(store.run.costIncomplete ? { costIncomplete: true } : {}),
          ...(store.run.stoppedEarly ? { stoppedEarly: store.run.stoppedEarly } : {}),
          paths: {
            tasks: 'TASKS.md',
            blocked: 'BLOCKED.md',
            journal: '.kalfa/journal.jsonl',
            adrs: 'docs/adr/README.md',
            ...(store.run.runDir ? { runDir: store.run.runDir } : {}),
          },
          ...extra,
        },
        cwd,
      );
      if (warning) process.stderr.write(`kalfa: ${warning}\n`);
    };

    let summary;
    try {
      summary = await runner.run();
    } catch (err) {
      release();
      // The run died mid-flight. Whoever is asleep still needs telling — that
      // is the whole point of a notification hook, and a failure is the case
      // where waiting for a message that never comes costs the most.
      await announce('failed', { error: (err as Error).message });
      throw err;
    } finally {
      release();
    }
    const { counts } = summary;

    const needsYou = counts.blocked > 0 || counts.skipped > 0;

    // In --jsonl mode stdout belongs to the consumer; the human summary goes
    // to stderr rather than corrupting the stream with prose.
    const out = opts.jsonl
      ? (text: string): void => void process.stderr.write(text)
      : (text: string): void => void process.stdout.write(text);

    out(
      `\n${counts.done} done, ${counts.blocked} blocked, ${counts.skipped} skipped` +
        `  ·  ${usd(summary.costUsd)}${store.run.costIncomplete ? '+' : ''}` +
        `  ·  ${seconds(Date.now() - startedAt)}\n`,
    );
    if (store.run.costIncomplete) {
      out(
        `cost shown is a FLOOR: the codex CLI does not report per-run spend, so the\n` +
          `reviewer's cost is missing — including from the max_run_cost_usd ceiling.\n`,
      );
    }
    if (summary.branch) out(`branch ${summary.branch}\n`);
    if (summary.stoppedEarly) out(`stopped early: ${summary.stoppedEarly}\n`);
    if (needsYou) out(`read BLOCKED.md for what needs you\n`);
    out(`read docs/adr/README.md for what it decided instead of asking\n`);
    if (artifacts) out(`every attempt's full evidence is in ${artifacts.rel(artifacts.dir)}/artifacts/\n`);
    if (needsYou) {
      out(`resume with: kalfa run --run-id ${runId}\n`);
      process.exitCode = 2;
    }

    await announce(needsYou ? 'blocked' : 'completed');
  });

program.parseAsync(process.argv).catch((err: Error) => fail(err.message));
