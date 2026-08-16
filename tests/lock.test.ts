import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, isProcessAlive, LockError, readLock } from '../src/state/lock.js';
import { ensureStateDir } from '../src/state/dir.js';

/**
 * Two concurrent runs in one working tree is not a race to lose gracefully —
 * they interleave commits, each `git add --all` sweeps up the other's
 * half-finished work, and both clobber state.json. These tests pin the
 * guard and, just as importantly, pin that it does NOT block on a stale lock.
 */

let dir: string;
const lockFile = (): string => join(dir, '.kalfa', 'run.lock');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kalfa-lock-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireLock', () => {
  it('writes a lock recording who holds it and why', () => {
    acquireLock(dir, { runId: 'r1', command: 'kalfa run' });
    const info = readLock(dir);
    expect(info?.pid).toBe(process.pid);
    expect(info?.runId).toBe('r1');
    expect(info?.command).toBe('kalfa run');
    expect(info?.startedAt).toBeTruthy();
  });

  it('refuses a second run while a live process holds the lock', () => {
    acquireLock(dir, { runId: 'r1', command: 'kalfa run', isAlive: () => true });
    expect(() => acquireLock(dir, { runId: 'r2', command: 'kalfa run', isAlive: () => true })).toThrow(
      LockError,
    );
  });

  it('explains what to do rather than just failing', () => {
    acquireLock(dir, { runId: 'r1', command: 'kalfa run', isAlive: () => true });
    try {
      acquireLock(dir, { runId: 'r2', command: 'kalfa run', isAlive: () => true });
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as LockError).message;
      expect(message).toContain('r1');
      expect(message).toMatch(/corrupt each other/);
      expect(message).toMatch(/--force/);
      expect((err as LockError).held.runId).toBe('r1');
    }
  });

  it('takes over a lock whose process is gone, so a crash does not block forever', () => {
    ensureStateDir(dir);
    writeFileSync(
      lockFile(),
      JSON.stringify({ pid: 999999, runId: 'dead', startedAt: 'x', command: 'kalfa run' }),
      'utf8',
    );
    // The previous run crashed; the next one must not be stuck behind it.
    acquireLock(dir, { runId: 'r2', command: 'kalfa run', isAlive: () => false });
    expect(readLock(dir)?.runId).toBe('r2');
  });

  it('takes over on --force even when the holder looks alive', () => {
    acquireLock(dir, { runId: 'r1', command: 'kalfa run', isAlive: () => true });
    acquireLock(dir, { runId: 'r2', command: 'kalfa run', force: true, isAlive: () => true });
    expect(readLock(dir)?.runId).toBe('r2');
  });

  it('treats an unparseable lock as absent rather than refusing to run', () => {
    ensureStateDir(dir);
    writeFileSync(lockFile(), 'not json at all', 'utf8');
    expect(readLock(dir)).toBeUndefined();
    acquireLock(dir, { runId: 'r2', command: 'kalfa run' });
    expect(readLock(dir)?.runId).toBe('r2');
  });

  it('creates the state directory if the run is the first thing to touch it', () => {
    acquireLock(dir, { runId: 'r1', command: 'kalfa run' });
    expect(existsSync(join(dir, '.kalfa', '.gitignore'))).toBe(true);
  });
});

describe('release', () => {
  it('removes the lock so the next run can start', () => {
    const release = acquireLock(dir, { runId: 'r1', command: 'kalfa run' });
    release();
    expect(existsSync(lockFile())).toBe(false);
  });

  it('is idempotent — release runs from both a finally block and process exit', () => {
    const release = acquireLock(dir, { runId: 'r1', command: 'kalfa run' });
    release();
    expect(() => release()).not.toThrow();
  });

  it('does not free a lock that a --force takeover has since claimed', () => {
    const release = acquireLock(dir, { runId: 'r1', command: 'kalfa run' });
    // Simulate another process taking over.
    writeFileSync(
      lockFile(),
      JSON.stringify({ pid: 424242, runId: 'r2', startedAt: 'x', command: 'kalfa run' }),
      'utf8',
    );
    release();
    expect(JSON.parse(readFileSync(lockFile(), 'utf8')).runId).toBe('r2');
  });
});

describe('isProcessAlive', () => {
  it('sees this process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('does not see an implausible pid', () => {
    expect(isProcessAlive(999999)).toBe(false);
  });

  it('rejects nonsense rather than throwing', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

/**
 * Kalfa's progress output used to drown in git chatter on Windows: a CRLF
 * warning per staged file, and a "fatal: Needed a single revision" from the
 * routine probe for a branch that does not exist yet — which reads as a crash
 * in the middle of a successful run.
 */
describe('git calls do not leak to the terminal', () => {
  it('captures stderr rather than forwarding it', async () => {
    const gitModule = await import('../src/git/git.js');
    const repo = mkdtempSync(join(tmpdir(), 'kalfa-gitquiet-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });

      const written: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      (process.stderr as unknown as { write: (c: string | Uint8Array) => boolean }).write = (chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      };
      try {
        // Probing a branch that does not exist makes git print to stderr.
        expect(gitModule.branchExists(repo, 'no-such-branch')).toBe(false);
      } finally {
        (process.stderr as unknown as { write: (c: string | Uint8Array) => boolean }).write = original;
      }

      expect(written.join('')).not.toContain('fatal');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
