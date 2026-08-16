import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { PlanSchema } from '../src/plan/schema.js';
import { Runner, type RunnerEvent } from '../src/runner/runner.js';
import { StateStore } from '../src/state/store.js';
import { Journal } from '../src/journal/journal.js';
import { ArtifactStore } from '../src/state/artifacts.js';
import type { AgentInvoker } from '../src/agents/provider.js';
import type { AgentRun } from '../src/types.js';
import type { JournalEvent } from '../src/journal/journal.js';

/**
 * "Where is the complete, untruncated evidence?"
 *
 * A real run could report `gate project-check FAIL`, `review 2 blocking` and a
 * shortened retry cause, and nothing on disk connected any of it to the code,
 * the command output or the reviewer's actual words. These tests pin the
 * chain: every summary the run prints names a file, and that file exists.
 */

let repo: string;

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'kalfa-artifacts-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'seed.txt'), 'seed\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'seed']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function stubAgent(script: Array<() => AgentRun>, label = 'stub'): AgentInvoker {
  let call = 0;
  return {
    label,
    provider: 'claude',
    invoke: async () => script[Math.min(call++, script.length - 1)]!(),
  } as unknown as AgentInvoker;
}

const ok = (text = 'done'): AgentRun => ({
  text,
  ok: true,
  costUsd: 0.01,
  costKnown: true,
  durationMs: 5,
  toolEventsSupported: true,
});

const writes =
  (name: string, content = 'x\n') =>
  (): AgentRun => {
    writeFileSync(join(repo, name), content, 'utf8');
    return ok();
  };

function harness(
  configOver: Record<string, unknown>,
  tasks: Array<Record<string, unknown>>,
  invokers: { builder: AgentInvoker; reviewer?: AgentInvoker },
) {
  const config = ConfigSchema.parse({
    agents: { builder: { provider: 'claude' } },
    gates: [],
    policy: { review: false },
    ...configOver,
  });
  const plan = PlanSchema.parse({ version: 1, goal: 'test', tasks });
  const store = new StateStore(repo, 'testrun', 'plan.json');
  const journal = new Journal(repo, 'testrun');
  const events: RunnerEvent[] = [];
  const runner = new Runner({
    cwd: repo,
    config,
    plan,
    planPath: 'plan.json',
    runId: 'testrun',
    store,
    journal,
    artifacts: new ArtifactStore(repo, 'testrun'),
    onEvent: (event) => events.push(event),
    makeInvoker: (role) => (role === 'builder' ? invokers.builder : invokers.reviewer!),
  });
  return { runner, store, journal, events };
}

const readJournal = (): JournalEvent[] =>
  readFileSync(join(repo, '.kalfa', 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as JournalEvent);

const exists = (relative: string): boolean => existsSync(join(repo, relative));

describe('per-attempt artifacts', () => {
  it('writes the builder report and the diff the reviewer was shown', async () => {
    const { runner } = harness({}, [{ id: 'T1', title: 'first' }], {
      builder: stubAgent([writes('a.txt', 'hello\n')]),
    });
    await runner.run();

    const dir = '.kalfa/runs/testrun/artifacts/T1/1';
    expect(exists(`${dir}/builder.report.md`)).toBe(true);
    expect(exists(`${dir}/diff.patch`)).toBe(true);
    expect(readFileSync(join(repo, dir, 'diff.patch'), 'utf8')).toContain('hello');
    expect(exists(`${dir}/decision.json`)).toBe(true);
  });

  it('keeps each gate\'s streams separately, at a path the failure line cites', async () => {
    const { runner, events } = harness(
      {
        gates: [{ name: 'check', run: 'echo to-stdout && echo to-stderr 1>&2 && exit 1' }],
        policy: { review: false, max_attempts: 1 },
      },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('a.txt')]) },
    );
    await runner.run();

    const dir = '.kalfa/runs/testrun/artifacts/T1/1/gates';
    expect(readFileSync(join(repo, dir, 'check.stdout.log'), 'utf8')).toContain('to-stdout');
    expect(readFileSync(join(repo, dir, 'check.stderr.log'), 'utf8')).toContain('to-stderr');

    const gatesDone = events.find((e) => e.type === 'gates_done');
    expect(gatesDone && gatesDone.type === 'gates_done' && gatesDone.results[0]?.stdoutPath).toBe(
      `${dir}/check.stdout.log`,
    );
  });

  it('announces the exact gate command before running it', async () => {
    const { runner, events } = harness(
      { gates: [{ name: 'check', run: 'echo hi' }], policy: { review: false } },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('a.txt')]) },
    );
    await runner.run();

    const start = events.find((e) => e.type === 'command_start' && e.phase === 'gate');
    expect(start && start.type === 'command_start' && start.command).toBe('echo hi');
  });

  it('names the active phase as it happens, not afterwards', async () => {
    const { runner, events } = harness(
      { gates: [{ name: 'check', run: 'echo hi' }], policy: { review: false } },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('a.txt')]) },
    );
    await runner.run();

    const phases = events.filter((e) => e.type === 'phase').map((e) => (e.type === 'phase' ? e.phase : ''));
    expect(phases).toContain('preparing');
    expect(phases).toContain('builder');
    expect(phases).toContain('collecting_diff');
    expect(phases).toContain('commit');
  });

  it('makes a retry cite the attempt that caused it', async () => {
    const { runner, events } = harness(
      {
        gates: [{ name: 'check', run: 'node -e "process.exit(process.argv[1]?0:0)"' }],
        policy: { review: false, max_attempts: 2 },
      },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([() => ({ ...ok(), ok: false, error: 'worker exploded' }), writes('a.txt')]) },
    );
    await runner.run();

    const retry = events.find((e) => e.type === 'retrying');
    expect(retry && retry.type === 'retrying' && retry.causedBy).toBe(
      '.kalfa/runs/testrun/artifacts/T1/1',
    );

    const decision = JSON.parse(
      readFileSync(join(repo, '.kalfa/runs/testrun/artifacts/T1/1/decision.json'), 'utf8'),
    ) as { outcome: string; next: string; reason: string };
    expect(decision.outcome).toBe('agent_failed');
    expect(decision.next).toBe('retry');
    expect(decision.reason).toContain('worker exploded');
  });

  it('keeps the reviewer\'s complete response, not just the count', async () => {
    const findings = {
      findings: [
        { severity: 'blocker', summary: 'the test file was modified', file: 'a.test.ts', line: 3, suggestion: null },
      ],
    };
    const { runner, events } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        policy: { review: true, max_attempts: 1, review_second_opinion: false },
      },
      [{ id: 'T1', title: 'first' }],
      {
        builder: stubAgent([writes('a.txt')]),
        reviewer: stubAgent([() => ok(JSON.stringify(findings))], 'codex'),
      },
    );
    await runner.run();

    const dir = '.kalfa/runs/testrun/artifacts/T1/1';
    expect(exists(`${dir}/review.raw.txt`)).toBe(true);
    expect(exists(`${dir}/review.request.json`)).toBe(true);
    const saved = JSON.parse(readFileSync(join(repo, dir, 'review.findings.json'), 'utf8')) as typeof findings;
    expect(saved.findings[0]?.summary).toBe('the test file was modified');

    const done = events.find((e) => e.type === 'review_done');
    expect(done && done.type === 'review_done' && done.findingsPath).toBe(`${dir}/review.findings.json`);
  });

  it('keeps the reviewer\'s raw text even when it could not be parsed', async () => {
    const { runner } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        policy: { review: true, max_attempts: 1 },
      },
      [{ id: 'T1', title: 'first' }],
      {
        builder: stubAgent([writes('a.txt')]),
        reviewer: stubAgent([() => ok('I could not read the diff, sorry')], 'codex'),
      },
    );
    await runner.run();

    const raw = readFileSync(join(repo, '.kalfa/runs/testrun/artifacts/T1/1/review.raw.txt'), 'utf8');
    expect(raw).toContain('I could not read the diff');
  });

  it('points BLOCKED.md at the evidence rather than describing it', async () => {
    const { runner } = harness(
      { gates: [{ name: 'check', run: 'exit 1' }], policy: { review: false, max_attempts: 1 } },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('a.txt')]) },
    );
    await runner.run();

    const blocked = readFileSync(join(repo, 'BLOCKED.md'), 'utf8');
    expect(blocked).toContain('FULL EVIDENCE: .kalfa/runs/testrun/artifacts/T1/1/');
    expect(blocked).toContain('gates/check.stdout.log');
  });

  it('records the artifact directory on the attempt, so state.json cites it too', async () => {
    const { runner, store } = harness({}, [{ id: 'T1', title: 'first' }], {
      builder: stubAgent([writes('a.txt')]),
    });
    await runner.run();

    expect(store.task('T1').attempts[0]?.artifactsDir).toBe('.kalfa/runs/testrun/artifacts/T1/1');
    expect(store.run.runDir).toBe('.kalfa/runs/testrun');
  });
});

describe('the event stream', () => {
  it('journals phases and commands, not only outcomes', async () => {
    const { runner } = harness(
      { gates: [{ name: 'check', run: 'echo hi' }], policy: { review: false } },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('a.txt')]) },
    );
    await runner.run();

    const types = readJournal().map((e) => e.type);
    expect(types).toContain('phase');
    expect(types).toContain('command_started');
    expect(types).toContain('command_finished');

    const command = readJournal().find((e) => e.type === 'command_started' && e['name'] === 'check');
    expect(command?.['command']).toBe('echo hi');
    expect(command?.['phase']).toBe('gate');
    expect(command?.attempt).toBe(1);
  });

  it('is append-only and stays parseable line by line', async () => {
    const { runner } = harness({}, [{ id: 'T1', title: 'first' }, { id: 'T2', title: 'second' }], {
      builder: stubAgent([writes('a.txt'), writes('b.txt')]),
    });
    await runner.run();

    const events = readJournal();
    expect(events.length).toBeGreaterThan(10);
    expect(events.every((e) => typeof e.at === 'string' && e.runId === 'testrun')).toBe(true);
    expect(events[0]?.type).toBe('run_start');
    expect(events.at(-1)?.type).toBe('run_end');
  });

  it('never commits its own artifacts into the user\'s history', async () => {
    const { runner } = harness({}, [{ id: 'T1', title: 'first' }], {
      builder: stubAgent([writes('a.txt')]),
    });
    await runner.run();

    expect(git(['log', '--name-only', '--format='])).not.toContain('.kalfa');
    expect(git(['status', '--porcelain'])).toBe('');
  });
});
