import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JournalTail, describe as describeEvent, watchRun, WATCH_EXIT } from '../src/cli/watch.js';
import { notify } from '../src/cli/notify.js';
import { ensureStateDir } from '../src/state/dir.js';
import type { RunRecord } from '../src/types.js';

/**
 * An unattended runner that cannot be followed is only half a bargain: the
 * operator trades synchronous approval for asynchronous review, and then has
 * no way to learn that the run blocked an hour ago. These pin the two halves —
 * following a live run, and finding out that it ended.
 */

let dir: string;

const state = (record: Partial<RunRecord> & { runId: string }): void => {
  writeFileSync(
    join(dir, '.kalfa', 'state.json'),
    JSON.stringify({ startedAt: '2026-08-16T15:52:25Z', planPath: 'kalfa.plan.json', tasks: {}, ...record }),
    'utf8',
  );
};

const journal = (...events: Array<Record<string, unknown>>): void => {
  appendFileSync(
    join(dir, '.kalfa', 'journal.jsonl'),
    `${events.map((e) => JSON.stringify({ at: '2026-08-16T15:52:25.000Z', ...e })).join('\n')}\n`,
    'utf8',
  );
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kalfa-watch-'));
  ensureStateDir(dir);
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows holds a directory open for a moment after a killed child that
    // had it as its cwd. Leaving one temp directory behind is not a failure.
  }
});

describe('JournalTail', () => {
  it('returns only what was appended since the last read', () => {
    journal({ runId: 'r1', type: 'run_start' });
    const tail = new JournalTail(join(dir, '.kalfa', 'journal.jsonl'));

    expect(tail.read().map((e) => e.type)).toEqual(['run_start']);
    expect(tail.read()).toEqual([]);

    journal({ runId: 'r1', type: 'task_start', taskId: 'T1' });
    expect(tail.read().map((e) => e.type)).toEqual(['task_start']);
  });

  it('holds back a half-written line rather than losing the event', () => {
    const path = join(dir, '.kalfa', 'journal.jsonl');
    const tail = new JournalTail(path);
    appendFileSync(path, '{"runId":"r1","type":"task_st', 'utf8');
    expect(tail.read()).toEqual([]);

    appendFileSync(path, 'art","at":"now"}\n', 'utf8');
    expect(tail.read().map((e) => e.type)).toEqual(['task_start']);
  });

  it('re-reads from the start when the file shrinks under it', () => {
    const path = join(dir, '.kalfa', 'journal.jsonl');
    journal({ runId: 'r1', type: 'run_start' });
    const tail = new JournalTail(path);
    tail.read();

    writeFileSync(path, `${JSON.stringify({ at: 'now', runId: 'r1', type: 'run_end' })}\n`, 'utf8');
    expect(tail.read().map((e) => e.type)).toEqual(['run_end']);
  });

  it('is empty, not broken, before the run has written anything', () => {
    expect(new JournalTail(join(dir, '.kalfa', 'nothing.jsonl')).read()).toEqual([]);
  });
});

describe('event descriptions', () => {
  it('names the active phase in the operator\'s words', () => {
    expect(describeEvent({ at: 'now', runId: 'r1', type: 'phase', taskId: 'T5', attempt: 2, phase: 'builder' })).toContain(
      'builder running',
    );
  });

  it('prints the command a gate is about to run', () => {
    const line = describeEvent({
      at: 'now',
      runId: 'r1',
      type: 'command_started',
      taskId: 'T5',
      attempt: 2,
      name: 'test',
      command: 'godot --headless --run-tests',
    });
    expect(line).toContain('godot --headless --run-tests');
  });

  it('says nothing for events that add nothing', () => {
    expect(describeEvent({ at: 'now', runId: 'r1', type: 'artifact_failed' })).toBeUndefined();
  });
});

describe('watchRun', () => {
  const capture = async (opts: Parameters<typeof watchRun>[0] = { cwd: dir, json: false, tty: false }) => {
    let out = '';
    const code = await watchRun({ ...opts, cwd: dir, write: (text) => (out += text), sleep: async () => {} });
    return { out, code };
  };

  it('exits 1 with nothing to watch', async () => {
    const { code, out } = await capture({ cwd: dir, json: false, tty: false });
    expect(code).toBe(WATCH_EXIT.nothingToWatch);
    expect(out).toContain('no run state found');
  });

  it('exits 0 when a finished run left everything done', async () => {
    state({ runId: 'r1', finishedAt: '2026-08-16T18:00:00Z', tasks: { T1: taskRecord('done') } });
    journal({ runId: 'r1', type: 'run_start' }, { runId: 'r1', type: 'run_end' });

    const { code, out } = await capture();
    expect(code).toBe(WATCH_EXIT.clean);
    expect(out).toContain('finished');
  });

  it('exits 2 when the run finished but something needs a human', async () => {
    state({
      runId: 'r1',
      finishedAt: '2026-08-16T18:00:00Z',
      tasks: { T1: taskRecord('done'), T2: taskRecord('blocked') },
    });
    journal({ runId: 'r1', type: 'run_end' });

    const { code, out } = await capture();
    expect(code).toBe(WATCH_EXIT.needsYou);
    expect(out).toContain('read BLOCKED.md');
  });

  it('exits 3 rather than waiting forever for a run that died', async () => {
    // No lock, no finishedAt, no run_end: the process was killed or the
    // machine rebooted. Waiting for an event that will never arrive is the one
    // failure mode a watcher must not have.
    state({ runId: 'r1', tasks: { T1: taskRecord('running') } });
    journal({ runId: 'r1', type: 'run_start' });

    const { code, out } = await capture();
    expect(code).toBe(WATCH_EXIT.died);
    expect(out).toContain('kalfa run --run-id r1');
  });

  /**
   * The only test here that runs the watcher as its own process.
   *
   * Every other one injects `sleep`, which is how a watcher that returned
   * immediately passed the whole suite. Against a live run it printed the
   * backlog and exited 0 after one second with the build still going — and 0
   * means "finished, every task done", so it was not giving up early, it was
   * reporting success over a run in progress. The cause was an `unref()` on
   * the poll timer: nothing else in the loop is asynchronous, so an unref'd
   * timer left node with an empty event loop and it exited.
   *
   * In-process this is invisible. The test runner's own handles keep the loop
   * alive, so the unref'd version passes an in-process assertion — which is
   * exactly what it did when this regression test was first written the easy
   * way. Only a real process can tell the difference.
   */
  it('does not exit while the run it is watching is still alive', async () => {
    writeFileSync(
      join(dir, '.kalfa', 'run.lock'),
      // This process, so the watcher's liveness check sees a live pid.
      JSON.stringify({ pid: process.pid, runId: 'r1', startedAt: '2026-08-16T15:52:25Z' }),
      'utf8',
    );
    state({ runId: 'r1', tasks: { T1: taskRecord('running') } });
    journal({ runId: 'r1', type: 'run_start' });

    const root = fileURLToPath(new URL('..', import.meta.url));
    const child = spawn(
      process.execPath,
      [
        join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(root, 'src', 'cli', 'main.ts'),
        'status',
        '--watch',
        '--interval',
        '50',
      ],
      { cwd: dir, stdio: 'ignore' },
    );
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

    try {
      await new Promise((r) => setTimeout(r, 2500));
      expect(child.exitCode, 'the watcher exited while the run was still going').toBeNull();

      // And it still ends when the run does, rather than hanging forever.
      state({ runId: 'r1', finishedAt: '2026-08-16T18:00:00Z', tasks: { T1: taskRecord('done') } });
      journal({ runId: 'r1', type: 'run_end' });
      await expect(exited).resolves.toBe(WATCH_EXIT.clean);
    } finally {
      child.kill();
    }
  }, 20_000);

  it('catches up on a run already in progress before following it', async () => {
    state({ runId: 'r1', finishedAt: '2026-08-16T18:00:00Z', tasks: { T1: taskRecord('done') } });
    journal(
      { runId: 'r1', type: 'run_start', total: 3 },
      { runId: 'r1', type: 'task_start', taskId: 'T1', title: 'First' },
      { runId: 'r1', type: 'task_done', taskId: 'T1', commit: 'abcdef1234' },
      { runId: 'r1', type: 'run_end' },
    );

    const { out } = await capture();
    expect(out).toContain('watching run r1');
    expect(out).toContain('4 events so far');
    expect(out).toContain('T1 DONE');
  });

  it('ignores events belonging to a different run', async () => {
    state({ runId: 'r2', finishedAt: '2026-08-16T18:00:00Z', tasks: {} });
    journal({ runId: 'r1', type: 'task_blocked', taskId: 'T9', reason: 'old run' });
    journal({ runId: 'r2', type: 'run_end' });

    const { out } = await capture();
    expect(out).not.toContain('T9');
  });

  it('emits raw events under --json, for a consumer that is not a person', async () => {
    state({ runId: 'r1', finishedAt: '2026-08-16T18:00:00Z', tasks: {} });
    journal({ runId: 'r1', type: 'run_start' }, { runId: 'r1', type: 'run_end' });

    const { out } = await capture({ cwd: dir, json: true, tty: false });
    const lines = out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l['type'])).toEqual(['run_start', 'run_end']);
  });
});

describe('notify', () => {
  const isWindows = process.platform === 'win32';

  it('does nothing when no command is configured', async () => {
    const warning = await notify({ on: ['completed'], timeout_ms: 1000 }, payload('completed'), dir);
    expect(warning).toBeUndefined();
  });

  it('does not fire for an event the user did not ask about', async () => {
    const marker = join(dir, 'fired.txt');
    await notify(
      { command: `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}','x')"`, on: ['failed'], timeout_ms: 5000 },
      payload('completed'),
      dir,
    );
    expect(() => rmSync(marker)).toThrow();
  });

  it('hands the run summary to the command on stdin', async () => {
    const out = join(dir, 'payload.json').replace(/\\/g, '/');
    const warning = await notify(
      {
        command: `node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>require('fs').writeFileSync('${out}',s))"`,
        on: ['completed', 'blocked', 'failed'],
        timeout_ms: 10000,
      },
      payload('blocked'),
      dir,
    );

    expect(warning).toBeUndefined();
    const received = JSON.parse(require('node:fs').readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect(received['event']).toBe('blocked');
    expect(received['runId']).toBe('r1');
    expect((received['paths'] as Record<string, string>)['blocked']).toBe('BLOCKED.md');
  });

  it('reports a failing hook without letting it change the run', async () => {
    const warning = await notify(
      { command: isWindows ? 'exit 3' : 'exit 3', on: ['completed'], timeout_ms: 5000 },
      payload('completed'),
      dir,
    );
    expect(warning).toContain('exited 3');
  });

  it('kills a hook that hangs', async () => {
    const warning = await notify(
      { command: 'node -e "setTimeout(()=>{}, 60000)"', on: ['completed'], timeout_ms: 300 },
      payload('completed'),
      dir,
    );
    expect(warning).toContain('timed out');
  });
});

function payload(event: 'completed' | 'blocked' | 'failed') {
  return {
    event,
    runId: 'r1',
    paths: { tasks: 'TASKS.md', blocked: 'BLOCKED.md', journal: '.kalfa/journal.jsonl', adrs: 'docs/adr/README.md' },
  };
}

function taskRecord(status: 'done' | 'blocked' | 'running') {
  return { id: 'T', status, attempts: [], costUsd: 0, durationMs: 0 };
}
