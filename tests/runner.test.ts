import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import { PlanSchema } from '../src/plan/schema.js';
import { Runner } from '../src/runner/runner.js';
import { StateStore } from '../src/state/store.js';
import { Journal } from '../src/journal/journal.js';
import type { AgentInvoker } from '../src/agents/provider.js';
import type { AgentRun } from '../src/types.js';

/**
 * The runner is exercised against a real git repository in a temp dir, with
 * the agents stubbed. Git behaviour — commit per task, stash on failure, a
 * clean tree between tasks — is the part most worth testing, and mocking it
 * would test nothing.
 */

let repo: string;

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'kalfa-test-'));
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

/** A stub agent whose behaviour is scripted per invocation. */
function stubAgent(script: Array<() => AgentRun>, label = 'stub'): AgentInvoker {
  let call = 0;
  return {
    label,
    provider: 'claude',
    invoke: async () => {
      const step = script[Math.min(call, script.length - 1)]!;
      call += 1;
      return step();
    },
  } as unknown as AgentInvoker;
}

const ok = (): AgentRun => ({ text: 'done', ok: true, costUsd: 0.01, costKnown: true, durationMs: 5 });

/** Simulates a worker that edits a file, which is what makes a task committable. */
const writes = (name: string, content = 'x\n') =>
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
  const runner = new Runner({
    cwd: repo,
    config,
    plan,
    planPath: 'plan.json',
    runId: 'testrun',
    store,
    journal,
    makeInvoker: (role) => (role === 'builder' ? invokers.builder : invokers.reviewer!),
  });
  return { runner, store, config };
}

describe('runner: the happy path', () => {
  it('commits one commit per task and reports done', async () => {
    const { runner, store } = harness({}, [{ id: 'T1', title: 'first' }, { id: 'T2', title: 'second' }], {
      builder: stubAgent([writes('a.txt'), writes('b.txt')]),
    });

    const summary = await runner.run();

    expect(summary.counts.done).toBe(2);
    expect(summary.counts.blocked).toBe(0);
    expect(store.task('T1').commit).toBeTruthy();
    // seed + begin-run + (start + task) per task + finish-run
    expect(git(['log', '--oneline']).split('\n')).toHaveLength(7);
    expect(git(['status', '--porcelain'])).toBe('');
  });

  // A live reviewer's only finding, on the first run where review worked, was
  // that the task commit contained Kalfa's board churn rather than anything
  // about the code. Bookkeeping must land before the builder starts.
  it('keeps its own bookkeeping out of the task commit', async () => {
    const { runner } = harness({}, [{ id: 'T1', title: 'first' }], {
      builder: stubAgent([writes('a.txt')]),
    });
    await runner.run();

    const files = git(['show', '--name-only', '--format=', 'HEAD~1'])
      .split('\n')
      .filter(Boolean);
    expect(files).toEqual(['a.txt']);
    expect(files).not.toContain('TASKS.md');
  });

  it('records the run id in the commit message, so work is traceable', async () => {
    const { runner } = harness({}, [{ id: 'T1', title: 'first' }], {
      builder: stubAgent([writes('a.txt')]),
    });
    await runner.run();
    expect(git(['log', '--format=%B'])).toContain('kalfa-run: testrun');
  });

  it('cuts a branch for the run', async () => {
    const { runner } = harness({ policy: { review: false, branch: 'kalfa/{run_id}' } }, [
      { id: 'T1', title: 'first' },
    ], { builder: stubAgent([writes('a.txt')]) });
    await runner.run();
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('kalfa/testrun');
  });
});

describe('runner: kalfa keeps its own state out of the repository', () => {
  // Regression guard. `git add --all` once committed run state into the user's
  // history, and `git stash --include-untracked` once deleted it mid-run.
  it('never commits .kalfa and survives a stash', async () => {
    const { runner } = harness(
      { gates: [{ name: 'fails', run: 'exit 1' }], policy: { review: false, max_attempts: 1 } },
      [{ id: 'T1', title: 'a' }, { id: 'T2', title: 'b' }],
      { builder: stubAgent([writes('a.txt'), writes('b.txt')]) },
    );

    await runner.run();

    expect(git(['ls-files'])).not.toContain('.kalfa');
    expect(existsSync(join(repo, '.kalfa', 'state.json'))).toBe(true);
    expect(existsSync(join(repo, '.kalfa', 'journal.jsonl'))).toBe(true);
  });
});

describe('runner: failure handling', () => {
  it('retries on a failing gate and commits once it passes', async () => {
    const flag = join(repo, 'pass.txt');
    const { runner, store } = harness(
      {
        gates: [{ name: 'check', run: process.platform === 'win32' ? 'if exist pass.txt (exit 0) else (exit 1)' : 'test -f pass.txt' }],
        policy: { review: false, max_attempts: 3 },
      },
      [{ id: 'T1', title: 'first' }],
      {
        builder: stubAgent([
          writes('a.txt'),
          () => {
            writeFileSync(flag, 'ok\n', 'utf8');
            return ok();
          },
        ]),
      },
    );

    const summary = await runner.run();
    expect(summary.counts.done).toBe(1);
    expect(store.task('T1').attempts).toHaveLength(2);
    expect(store.task('T1').attempts[0]?.outcome).toBe('gate_failed');
    expect(store.task('T1').attempts[1]?.outcome).toBe('passed');
  });

  it('blocks a task whose gate never passes, and leaves a clean tree behind', async () => {
    const { runner, store } = harness(
      { gates: [{ name: 'always-fails', run: 'exit 1' }], policy: { review: false, max_attempts: 2 } },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('a.txt')]) },
    );

    const summary = await runner.run();

    expect(summary.counts.blocked).toBe(1);
    expect(store.task('T1').attempts).toHaveLength(2);
    // The abandoned work is stashed, not committed and not left in the tree.
    expect(git(['status', '--porcelain'])).toBe('');
    expect(git(['stash', 'list'])).toContain('blocked T1');
    // The report and the board survive the stash rather than being parked
    // with the work they describe.
    expect(existsSync(join(repo, 'BLOCKED.md'))).toBe(true);
    expect(git(['log', '--format=%s'])).toContain('kalfa: blocked T1');
    expect(readFileSync(join(repo, 'TASKS.md'), 'utf8')).toContain('blocked');
  });

  it('treats an empty diff as a failure rather than a silent pass', async () => {
    const { runner, store } = harness({ policy: { review: false, max_attempts: 2 } }, [
      { id: 'T1', title: 'first' },
    ], { builder: stubAgent([ok]) }); // never writes anything

    const summary = await runner.run();
    expect(summary.counts.done).toBe(0);
    expect(summary.counts.blocked).toBe(1);
    expect(store.task('T1').attempts.every((a) => a.outcome === 'agent_failed')).toBe(true);
  });

  /**
   * From a live run: attempt 1 fixed the bug, the reviewer raised a blocker
   * that was simply false, and attempt 2 correctly answered "the earlier fix
   * is right, nothing to change". Kalfa measured that attempt against the
   * start of the attempt, saw no delta, scored it as having done nothing, and
   * stashed a perfectly good fix.
   */
  it('does not punish a retry for leaving an earlier attempt\'s correct work alone', async () => {
    let reviewCall = 0;
    const { runner, store } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        policy: { review: true, max_attempts: 2 },
      },
      [{ id: 'T1', title: 'first' }],
      {
        builder: stubAgent([
          writes('a.txt', 'the correct fix\n'),
          ok, // attempt 2 changes nothing on purpose
        ]),
        reviewer: stubAgent([
          () => ({
            text: JSON.stringify({ findings: [{ severity: 'major', summary: 'wrong' }] }),
            ok: true,
            costUsd: 0, costKnown: true,
            durationMs: 1,
          }),
          () => ({ text: '{"findings":[]}', ok: true, costUsd: 0, costKnown: true, durationMs: 1 }),
        ]),
      },
    );
    void reviewCall;

    const summary = await runner.run();

    // Attempt 2 must reach the gates and the reviewer, not be rejected as a
    // no-op, so the false blocker can be withdrawn and the work committed.
    expect(summary.counts.done).toBe(1);
    expect(store.task('T1').attempts[1]?.outcome).toBe('passed');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('the correct fix\n');
  });

  it('still fails a first attempt that produced nothing at all', async () => {
    const { runner, store } = harness({ policy: { review: false, max_attempts: 1 } }, [
      { id: 'T1', title: 'first' },
    ], { builder: stubAgent([ok]) });

    await runner.run();
    expect(store.task('T1').attempts[0]?.outcome).toBe('agent_failed');
  });

  it('records the dispute in BLOCKED.md so a human can adjudicate', async () => {
    const { runner } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        gates: [{ name: 'check', run: 'exit 0' }],
        policy: { review: true, max_attempts: 1 },
      },
      [{ id: 'T1', title: 'first' }],
      {
        builder: stubAgent([
          () => {
            writeFileSync(join(repo, 'a.txt'), 'x\n', 'utf8');
            return { text: 'I disagree: the file was never touched.', ok: true, costUsd: 0, costKnown: true, durationMs: 1 };
          },
        ]),
        reviewer: stubAgent([
          () => ({
            text: JSON.stringify({
              findings: [{ severity: 'blocker', summary: 'check.mjs was modified' }],
            }),
            ok: true,
            costUsd: 0, costKnown: true,
            durationMs: 1,
          }),
        ]),
      },
    );

    await runner.run();
    const blocked = readFileSync(join(repo, 'BLOCKED.md'), 'utf8');

    // Gates green + review blocked is the shape of a disputed finding, and
    // the worker's answer is the other half of the argument.
    expect(blocked).toContain('GATES: all passed');
    expect(blocked).toContain('check.mjs was modified');
    expect(blocked).toContain('I disagree');
    expect(blocked).toContain('git stash apply');
  });

  it('skips a task whose dependency was blocked, instead of building on sand', async () => {
    const { runner, store } = harness(
      { gates: [{ name: 'fails', run: 'exit 1' }], policy: { review: false, max_attempts: 1 } },
      [
        { id: 'T1', title: 'first' },
        { id: 'T2', title: 'second', deps: ['T1'] },
      ],
      { builder: stubAgent([writes('a.txt')]) },
    );

    const summary = await runner.run();
    expect(summary.counts.blocked).toBe(1);
    expect(summary.counts.skipped).toBe(1);
    expect(store.task('T2').reason).toContain('dependencies not satisfied');
  });

  it('stops the run after too many consecutive blocks', async () => {
    const { runner } = harness(
      {
        gates: [{ name: 'fails', run: 'exit 1' }],
        policy: { review: false, max_attempts: 1, abort_after_consecutive_blocks: 2 },
      },
      [
        { id: 'T1', title: 'a' },
        { id: 'T2', title: 'b' },
        { id: 'T3', title: 'c' },
      ],
      { builder: stubAgent([writes('a.txt'), writes('b.txt'), writes('c.txt')]) },
    );

    const summary = await runner.run();
    expect(summary.stoppedEarly).toContain('consecutive');
    expect(summary.counts.blocked).toBe(2);
    expect(summary.counts.pending + summary.counts.skipped).toBeLessThanOrEqual(1);
  });
});

describe('runner: the review gate', () => {
  const reviewJson = (findings: unknown[]): AgentRun => ({
    text: JSON.stringify({ findings }),
    ok: true,
    costUsd: 0.002, costKnown: true,
    durationMs: 3,
  });

  it('retries when the reviewer reports a blocking finding, then commits when clean', async () => {
    const { runner, store } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        policy: { review: true, blocking_severity: 'major', max_attempts: 3 },
      },
      [{ id: 'T1', title: 'first' }],
      {
        builder: stubAgent([writes('a.txt'), writes('a.txt', 'fixed\n')]),
        reviewer: stubAgent([
          () => reviewJson([{ severity: 'major', summary: 'race condition' }]),
          () => reviewJson([]),
        ]),
      },
    );

    const summary = await runner.run();
    expect(summary.counts.done).toBe(1);
    expect(store.task('T1').attempts[0]?.outcome).toBe('review_failed');
    expect(store.task('T1').attempts[1]?.outcome).toBe('passed');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('fixed\n');
  });

  it('ignores findings below the blocking threshold', async () => {
    const { runner } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        policy: { review: true, blocking_severity: 'major' },
      },
      [{ id: 'T1', title: 'first' }],
      {
        builder: stubAgent([writes('a.txt')]),
        reviewer: stubAgent([() => reviewJson([{ severity: 'minor', summary: 'naming' }])]),
      },
    );

    expect((await runner.run()).counts.done).toBe(1);
  });

  it('blocks rather than passes when the reviewer output cannot be parsed', async () => {
    const { runner, store } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        policy: { review: true },
      },
      [{ id: 'T1', title: 'first' }],
      {
        builder: stubAgent([writes('a.txt')]),
        reviewer: stubAgent([() => ({ text: 'lgtm!', ok: true, costUsd: 0, costKnown: true, durationMs: 1 })]),
      },
    );

    const summary = await runner.run();
    expect(summary.counts.done).toBe(0);
    expect(store.task('T1').reason).toContain('reviewer');
  });
});

describe('runner: resume', () => {
  it('skips tasks already marked done by an earlier run of the same id', async () => {
    const first = harness({}, [{ id: 'T1', title: 'a' }, { id: 'T2', title: 'b' }], {
      builder: stubAgent([writes('a.txt'), writes('b.txt')]),
    });
    await first.runner.run();
    const commitsAfterFirst = git(['log', '--oneline']).split('\n').length;

    let calls = 0;
    const second = harness({}, [{ id: 'T1', title: 'a' }, { id: 'T2', title: 'b' }], {
      builder: stubAgent([
        () => {
          calls += 1;
          return ok();
        },
      ]),
    });
    await second.runner.run();

    expect(calls).toBe(0);
    // Only bookkeeping moved: the board's "finished" timestamp changed. No
    // task was re-run, so no task commit was added.
    const added = git(['log', '--oneline']).split('\n').length - commitsAfterFirst;
    expect(added).toBeLessThanOrEqual(1);
    expect(git(['log', '-1', '--format=%s'])).toMatch(/^kalfa: /);
  });
});

describe('runner: honest accounting', () => {
  const codexRun = (): AgentRun => ({
    text: '{"findings":[]}',
    ok: true,
    costUsd: 0,
    costKnown: false, // what the real codex provider reports
    durationMs: 1,
  });

  it('flags the run total as incomplete when an agent cannot report its cost', async () => {
    const { runner, store } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        policy: { review: true },
      },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('a.txt')]), reviewer: stubAgent([codexRun]) },
    );

    await runner.run();
    expect(store.run.costIncomplete).toBe(true);
  });

  it('does not flag a run where every agent reported its cost', async () => {
    const { runner, store } = harness({}, [{ id: 'T1', title: 'first' }], {
      builder: stubAgent([writes('a.txt')]),
    });
    await runner.run();
    expect(store.run.costIncomplete).toBeUndefined();
  });
});

describe('runner: retries see the whole history', () => {
  it('tells attempt 3 what attempt 1 failed on, not just attempt 2', async () => {
    const prompts: string[] = [];
    const recording = {
      label: 'stub',
      provider: 'claude',
      invoke: async (prompt: string) => {
        prompts.push(prompt);
        writeFileSync(join(repo, 'a.txt'), `attempt ${prompts.length}\n`, 'utf8');
        return ok();
      },
    } as unknown as AgentInvoker;

    const { runner } = harness(
      {
        gates: [{ name: 'always-fails', run: 'exit 1' }],
        policy: { review: false, max_attempts: 3 },
      },
      [{ id: 'T1', title: 'first' }],
      { builder: recording },
    );

    await runner.run();

    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('Already tried and failed');
    expect(prompts[2]).toContain('attempt 1 failed on');
    expect(prompts[2]).toContain('attempt 2 failed on');
    // The first attempt gets the plain task prompt, with no history at all.
    expect(prompts[0]).not.toContain('Already tried and failed');
  });
});

/**
 * Observed live: the reviewer invented a blocker ("the test file was
 * modified" when git showed it untouched), the task exhausted its attempts,
 * and correct work was stashed. On the final attempt a block costs the work,
 * not a retry, so it is worth one confirming read before throwing it away.
 */
describe('runner: second opinion before discarding work', () => {
  const blocks = (): AgentRun => ({
    text: JSON.stringify({ findings: [{ severity: 'blocker', summary: 'invented problem' }] }),
    ok: true,
    costUsd: 0,
    costKnown: false,
    durationMs: 1,
  });
  const clean = (): AgentRun => ({
    text: '{"findings":[]}',
    ok: true,
    costUsd: 0,
    costKnown: false,
    durationMs: 1,
  });

  const setup = (reviewerScript: Array<() => AgentRun>, maxAttempts = 1) =>
    harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        gates: [{ name: 'check', run: 'exit 0' }],
        policy: { review: true, max_attempts: maxAttempts },
      },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('a.txt')]), reviewer: stubAgent(reviewerScript) },
    );

  it('commits the work when the reviewer withdraws its finding on the second read', async () => {
    const { runner, store } = setup([blocks, clean]);
    const summary = await runner.run();

    expect(summary.counts.done).toBe(1);
    expect(store.task('T1').attempts[0]?.outcome).toBe('passed');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('x\n');
  });

  it('still blocks when the second read confirms the finding', async () => {
    const { runner, store } = setup([blocks, blocks]);
    const summary = await runner.run();

    expect(summary.counts.blocked).toBe(1);
    expect(store.task('T1').attempts[0]?.outcome).toBe('review_failed');
  });

  it('does not overturn a block on an unreadable second read — that is not evidence', async () => {
    const unreadable = (): AgentRun => ({
      text: 'lgtm I guess',
      ok: true,
      costUsd: 0,
      costKnown: false,
      durationMs: 1,
    });
    const { runner, store } = setup([blocks, unreadable]);
    expect((await runner.run()).counts.blocked).toBe(1);
    expect(store.task('T1').reason).toBeTruthy();
  });

  it('does not spend a second review on a non-final attempt, where a retry is cheaper', async () => {
    let reviews = 0;
    const counting = {
      label: 'stub',
      provider: 'codex',
      invoke: async (): Promise<AgentRun> => {
        reviews += 1;
        return reviews === 1 ? blocks() : clean();
      },
    } as unknown as AgentInvoker;

    const { runner } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        gates: [{ name: 'check', run: 'exit 0' }],
        policy: { review: true, max_attempts: 3 },
      },
      [{ id: 'T1', title: 'first' }],
      {
        builder: stubAgent([writes('a.txt'), writes('a.txt', 'second\n')]),
        reviewer: counting,
      },
    );

    await runner.run();
    // Attempt 1 blocked and simply retried; no confirming read was spent.
    expect(reviews).toBe(2);
  });

  it('can be turned off', async () => {
    const { runner } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        gates: [{ name: 'check', run: 'exit 0' }],
        policy: { review: true, max_attempts: 1, review_second_opinion: false },
      },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('a.txt')]), reviewer: stubAgent([blocks, clean]) },
    );
    expect((await runner.run()).counts.blocked).toBe(1);
  });
});

describe('runner: a task that rewrites tests never does it quietly', () => {
  it('flags the protected file, records it, and tells the reviewer to verify', async () => {
    let reviewPromptSeen = '';
    const reviewer = {
      label: 'stub',
      provider: 'codex',
      invoke: async (prompt: string): Promise<AgentRun> => {
        reviewPromptSeen = prompt;
        return { text: '{"findings":[]}', ok: true, costUsd: 0, costKnown: false, durationMs: 1 };
      },
    } as unknown as AgentInvoker;

    const { runner, store } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        policy: { review: true, max_attempts: 1 },
      },
      [{ id: 'T1', title: 'first' }],
      {
        builder: stubAgent([
          () => {
            writeFileSync(join(repo, 'thing.test.js'), 'weakened assertion\n', 'utf8');
            return ok();
          },
        ]),
        reviewer,
      },
    );

    await runner.run();

    expect(store.task('T1').protectedPaths).toEqual(['thing.test.js']);
    expect(reviewPromptSeen).toContain('This diff modifies protected files');
    expect(reviewPromptSeen).toContain('thing.test.js');
    expect(reviewPromptSeen).toMatch(/verify the justification independently/);

    // And it survives into the morning report rather than only the prompt.
    expect(readFileSync(join(repo, 'TASKS.md'), 'utf8')).toContain(
      'Tests and checks were modified',
    );
  });

  it('says nothing when only source files changed', async () => {
    let reviewPromptSeen = '';
    const reviewer = {
      label: 'stub',
      provider: 'codex',
      invoke: async (prompt: string): Promise<AgentRun> => {
        reviewPromptSeen = prompt;
        return { text: '{"findings":[]}', ok: true, costUsd: 0, costKnown: false, durationMs: 1 };
      },
    } as unknown as AgentInvoker;

    const { runner, store } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        policy: { review: true, max_attempts: 1 },
      },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('src.js')]), reviewer },
    );

    await runner.run();

    expect(store.task('T1').protectedPaths).toBeUndefined();
    expect(reviewPromptSeen).not.toContain('This diff modifies protected files');
    expect(readFileSync(join(repo, 'TASKS.md'), 'utf8')).not.toContain(
      'Tests and checks were modified',
    );
  });
});

/**
 * From a six-task run on a real codebase: the builder committed its own work,
 * Kalfa's tree-versus-HEAD check saw a clean tree, concluded nothing had been
 * produced, and retried twice before blocking — while the finished
 * implementation sat at HEAD, never gated and never reviewed. It cost about
 * $1.50 and skipped the two tasks that depended on it.
 *
 * The damage is worse than the waste: the reviewer reads `git diff HEAD`, so
 * committed work is invisible to it.
 */
describe('runner: a worker that commits its own work', () => {
  const commitsItself = (name: string) => (): AgentRun => {
    writeFileSync(join(repo, name), 'work\n', 'utf8');
    git(['add', '--all']);
    git(['commit', '-q', '-m', 'the worker committing on its own']);
    return ok();
  };

  it('undoes the commit and treats the work as produced', async () => {
    const { runner, store } = harness({ policy: { review: false, max_attempts: 2 } }, [
      { id: 'T1', title: 'first' },
    ], { builder: stubAgent([commitsItself('a.txt')]) });

    const summary = await runner.run();

    expect(summary.counts.done).toBe(1);
    expect(store.task('T1').attempts).toHaveLength(1);
    expect(store.task('T1').attempts[0]?.outcome).toBe('passed');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('work\n');
  });

  it('lets the gates and the reviewer see work that was committed away', async () => {
    let diffSeen = '';
    const reviewer = {
      label: 'stub',
      provider: 'codex',
      invoke: async (): Promise<AgentRun> => {
        // The reviewer's whole view is the uncommitted diff.
        diffSeen = git(['diff', 'HEAD', '--name-only']);
        return { text: '{"findings":[]}', ok: true, costUsd: 0, costKnown: false, durationMs: 1 };
      },
    } as unknown as AgentInvoker;

    const { runner } = harness(
      {
        agents: { builder: { provider: 'claude' }, reviewer: { provider: 'codex' } },
        policy: { review: true, max_attempts: 1 },
      },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([commitsItself('b.txt')]), reviewer },
    );

    await runner.run();
    expect(diffSeen).toContain('b.txt');
  });

  it('keeps the work in exactly one commit, Kalfa\'s own', async () => {
    const { runner } = harness({}, [{ id: 'T1', title: 'first' }], {
      builder: stubAgent([commitsItself('c.txt')]),
    });
    await runner.run();

    const subjects = git(['log', '--format=%s']).split('\n');
    expect(subjects).not.toContain('the worker committing on its own');
    expect(subjects.some((s) => s.startsWith('T1:'))).toBe(true);
  });
});

describe('runner: the blocked report matches reality', () => {
  it('does not send you to an empty stash when nothing was stashed', async () => {
    const { runner } = harness(
      {
        gates: [{ name: 'fails', run: 'exit 1' }],
        policy: { review: false, max_attempts: 1, stash_failed_work: false },
      },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('a.txt')]) },
    );

    await runner.run();
    const blocked = readFileSync(join(repo, 'BLOCKED.md'), 'utf8');
    expect(blocked).not.toContain('the work is in the stash');
    expect(blocked).toContain('nothing was stashed');
  });

  it('points at the stash when there really is one', async () => {
    const { runner } = harness(
      { gates: [{ name: 'fails', run: 'exit 1' }], policy: { review: false, max_attempts: 1 } },
      [{ id: 'T1', title: 'first' }],
      { builder: stubAgent([writes('a.txt')]) },
    );

    await runner.run();
    expect(readFileSync(join(repo, 'BLOCKED.md'), 'utf8')).toContain('the work is in the stash');
  });
});
