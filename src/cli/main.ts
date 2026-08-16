#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, loadConfig, loadPlan } from '../config/load.js';
import { Runner, type RunnerEvent } from '../runner/runner.js';
import { StateStore, makeRunId } from '../state/store.js';
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

/** Preflight: everything that must be true before an unattended run starts. */
function preflight(cwd: string): void {
  if (!git.isRepo(cwd)) fail('not a git repository — kalfa relies on git for commits and rollback');
  if (!git.hasCommits(cwd)) fail('this repository has no commits yet — make an initial commit first');
  if (!git.isClean(cwd)) {
    const lines = git.statusLines(cwd).slice(0, 10);
    fail(
      `working tree is dirty — commit or stash first, so kalfa can tell its own work from yours:\n` +
        lines.map((l) => `  ${l}`).join('\n'),
    );
  }
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
  .command('run')
  .description('Run the plan unattended')
  .option('-c, --config <path>', 'config file')
  .option('-p, --plan <path>', 'plan file', 'kalfa.plan.json')
  .option('--run-id <id>', 'resume an existing run instead of starting a new one')
  .option('--dry-run', 'print the execution order and exit')
  .action(async (opts: { config?: string; plan: string; runId?: string; dryRun?: boolean }) => {
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

    preflight(cwd);

    const runId = opts.runId ?? makeRunId();
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

    const summary = await runner.run();
    const { counts } = summary;

    process.stdout.write(
      `\n${counts.done} done, ${counts.blocked} blocked, ${counts.skipped} skipped` +
        `  ·  ${usd(summary.costUsd)}  ·  ${seconds(Date.now() - startedAt)}\n`,
    );
    if (summary.branch) process.stdout.write(`branch ${summary.branch}\n`);
    if (summary.stoppedEarly) process.stdout.write(`stopped early: ${summary.stoppedEarly}\n`);
    if (counts.blocked > 0 || counts.skipped > 0) {
      process.stdout.write(`read BLOCKED.md for what needs you\n`);
    }
    process.stdout.write(`read DECISIONS.md for what it assumed instead of asking\n`);
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
