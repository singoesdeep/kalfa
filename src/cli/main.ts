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
import { ensureStateDir } from '../state/dir.js';
import { acquireLock, LockError } from '../state/lock.js';
import { generateSpec, readSpec, writeSpec, PRD_PATH, SPEC_PATH } from '../spec/spec.js';
import { renderBoardPlain } from '../board/board.js';
import { runDoctor } from '../doctor/doctor.js';
import { renderReport } from '../doctor/render.js';
import { ConfigError, loadConfig, loadPlan } from '../config/load.js';
import { Runner, type RunnerEvent } from '../runner/runner.js';
import { StateStore, makeRunId, readRunRecord } from '../state/store.js';
import { Journal } from '../journal/journal.js';
import { topoOrder } from '../plan/schema.js';
import { AUTONOMY_CONTRACT } from '../prompts/contract.js';
import { EXAMPLE_CONFIG, EXAMPLE_PLAN } from '../config/templates.js';
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

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const usd = (n: number): string => `$${n.toFixed(4)}`;

/**
 * Preflight: everything that must be true before an unattended run starts.
 *
 * The dirty-tree rule is relaxed when resuming. A run killed mid-task leaves
 * that task's work in the tree by design — the retry prompt tells the worker
 * to go and read it — so refusing would strand the user at exactly the moment
 * resume exists for. It is reported rather than silently accepted.
 */
function preflight(cwd: string, resuming = false): void {
  if (!git.isRepo(cwd)) fail('not a git repository — kalfa relies on git for commits and rollback');
  if (!git.hasCommits(cwd)) fail('this repository has no commits yet — make an initial commit first');
  if (git.isClean(cwd)) return;

  const lines = git.statusLines(cwd).slice(0, 10);
  if (!resuming) {
    fail(
      `working tree is dirty — commit or stash first, so kalfa can tell its own work from yours:\n` +
        lines.map((l) => `  ${l}`).join('\n'),
    );
  }
  process.stdout.write(
    `resuming with uncommitted work in the tree — treating it as the interrupted task's:\n` +
      lines.map((l) => `  ${l}\n`).join('') +
      `\n`,
  );
}

program
  .command('init')
  .description('Write a starter kalfa.yaml and kalfa.plan.json')
  .option('-f, --force', 'overwrite existing files')
  .action((opts: { force?: boolean }) => {
    const cwd = process.cwd();
    for (const [name, content] of [
      ['kalfa.yaml', EXAMPLE_CONFIG],
      ['kalfa.plan.json', EXAMPLE_PLAN],
    ] as const) {
      const path = resolve(cwd, name);
      if (existsSync(path) && !opts.force) {
        process.stdout.write(`skipped ${name} (exists — pass --force to overwrite)\n`);
        continue;
      }
      writeFileSync(path, content, 'utf8');
      process.stdout.write(`wrote ${name}\n`);
    }
    process.stdout.write(
      '\nNext: edit kalfa.plan.json into real tasks, then `kalfa validate` and `kalfa run`.\n',
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
  .action((opts: { plan: string; json?: boolean }) => {
    const cwd = process.cwd();
    const run = readRunRecord(cwd);
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
  .action(async (opts: {
    config?: string;
    plan: string;
    runId?: string;
    dryRun?: boolean;
    force?: boolean;
    new?: boolean;
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
    const previous = readRunRecord(cwd);
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

    preflight(cwd, resuming);

    const runId = opts.runId ?? makeRunId();

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
      if (err instanceof LockError) fail(err.message);
      throw err;
    }
    const release = (): void => releaseLock();
    process.once('exit', release);

    const store = new StateStore(cwd, runId, planPath);
    const journal = new Journal(cwd, runId);

    const controller = new AbortController();
    const onSignal = (): void => {
      process.stdout.write('\n\nstopping after the current step — press Ctrl-C again to kill\n');
      controller.abort();
      process.once('SIGINT', () => process.exit(130));
    };
    process.once('SIGINT', onSignal);

    const startedAt = Date.now();
    process.stdout.write(`kalfa run ${runId}\n${plan.goal}\n\n`);

    const runner = new Runner({
      cwd,
      config,
      plan,
      planPath,
      runId,
      store,
      journal,
      signal: controller.signal,
      onEvent: (event) => render(event),
    });

    let summary;
    try {
      summary = await runner.run();
    } finally {
      release();
    }
    const { counts } = summary;

    process.stdout.write(
      `\n${counts.done} done, ${counts.blocked} blocked, ${counts.skipped} skipped` +
        `  ·  ${usd(summary.costUsd)}${store.run.costIncomplete ? '+' : ''}` +
        `  ·  ${seconds(Date.now() - startedAt)}\n`,
    );
    if (store.run.costIncomplete) {
      process.stdout.write(
        `cost shown is a FLOOR: the codex CLI does not report per-run spend, so the\n` +
          `reviewer's cost is missing — including from the max_run_cost_usd ceiling.\n`,
      );
    }
    if (summary.branch) process.stdout.write(`branch ${summary.branch}\n`);
    if (summary.stoppedEarly) process.stdout.write(`stopped early: ${summary.stoppedEarly}\n`);
    if (counts.blocked > 0 || counts.skipped > 0) {
      process.stdout.write(`read BLOCKED.md for what needs you\n`);
    }
    process.stdout.write(`read docs/adr/README.md for what it decided instead of asking\n`);
    if (counts.blocked > 0 || counts.skipped > 0) {
      process.stdout.write(`resume with: kalfa run --run-id ${runId}\n`);
      process.exitCode = 2;
    }
  });

function render(event: RunnerEvent): void {
  switch (event.type) {
    case 'run_start':
      process.stdout.write(
        `${event.total} tasks${event.branch ? ` on branch ${event.branch}` : ''}\n\n`,
      );
      break;
    case 'task_start':
      process.stdout.write(
        `[${event.index + 1}/${event.total}] ${event.task.id}: ${event.task.title}\n`,
      );
      break;
    case 'attempt_start':
      if (event.attempt > 1) {
        process.stdout.write(`  retry ${event.attempt}/${event.max}\n`);
      }
      break;
    case 'agent_done':
      process.stdout.write(
        `  builder  ${event.ok ? 'ok' : 'FAILED'}  ${seconds(event.durationMs)}` +
          `${event.costUsd > 0 ? `  ${usd(event.costUsd)}` : ''}\n`,
      );
      break;
    case 'gates_done':
      for (const gate of event.results) {
        if (gate.skipped) continue;
        process.stdout.write(
          `  gate     ${gate.name.padEnd(10)} ${gate.ok ? 'pass' : 'FAIL'}  ${seconds(gate.durationMs)}\n`,
        );
      }
      break;
    case 'protected_touched':
      process.stdout.write(
        `  ! touched tests/checks: ${event.files.join(', ')} — flagged for review
`,
      );
      break;
    case 'second_opinion':
      process.stdout.write(`  review   blocking — asking once more before discarding the work\n`);
      break;
    case 'review_done':
      process.stdout.write(
        event.error
          ? `  review   ERROR  ${event.error.slice(0, 120)}\n`
          : `  review   ${event.blocking > 0 ? `${event.blocking} blocking` : 'clean'}` +
            ` (${event.findings} finding${event.findings === 1 ? '' : 's'})\n`,
      );
      break;
    case 'task_done':
      if (event.status === 'done') {
        process.stdout.write(`  -> done${event.commit ? ` ${event.commit.slice(0, 8)}` : ''}\n\n`);
      } else {
        process.stdout.write(`  -> ${event.status.toUpperCase()}: ${event.reason ?? ''}\n\n`);
      }
      break;
    case 'run_end':
      break;
  }
}

program.parseAsync(process.argv).catch((err: Error) => fail(err.message));
