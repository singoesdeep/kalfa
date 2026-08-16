import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir } from './dir.js';

/**
 * One run at a time, per repository.
 *
 * Two concurrent runs in one working tree is not a race to lose gracefully —
 * it is data loss. They interleave commits, each `git add --all` sweeps up the
 * other's half-finished work, one's `git stash` swallows the other's edits,
 * and both write `.kalfa/state.json` with a last-writer-wins clobber. There is
 * no partial-credit outcome; the whole night is ruined.
 *
 * It is an easy mistake to make: kick off a run, forget it is going, open a
 * second terminal in the morning and start another.
 *
 * The lock records the pid so a crashed run does not block the next one
 * forever — a lock whose process is gone is stale and gets taken over.
 */

export interface LockInfo {
  pid: number;
  runId: string;
  startedAt: string;
  /** Free-text so a human reading the file knows what holds it. */
  command: string;
}

export class LockError extends Error {
  constructor(
    message: string,
    readonly held: LockInfo,
  ) {
    super(message);
    this.name = 'LockError';
  }
}

function lockPath(cwd: string, stateDir = '.kalfa'): string {
  return join(cwd, stateDir, 'run.lock');
}

export function readLock(cwd: string, stateDir = '.kalfa'): LockInfo | undefined {
  const path = lockPath(cwd, stateDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
  } catch {
    // A corrupt lock is treated as no lock: refusing to run because we cannot
    // parse our own bookkeeping would be worse than the race it guards.
    return undefined;
  }
}

/**
 * Is the process that took this lock still running?
 *
 * `kill(pid, 0)` tests for existence without signalling. EPERM means the
 * process exists but belongs to someone else — still alive, still holding it.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface AcquireOptions {
  runId: string;
  command: string;
  stateDir?: string;
  /** Take the lock even if a live process holds it. For `--force` only. */
  force?: boolean;
  /** Injection seam for tests. */
  isAlive?: (pid: number) => boolean;
}

/**
 * Take the lock, or throw with enough detail to act on.
 *
 * Returns a release function. Release is idempotent and never throws: a
 * failure to clean up must not mask the run's own outcome.
 */
export function acquireLock(cwd: string, opts: AcquireOptions): () => void {
  const stateDir = opts.stateDir ?? '.kalfa';
  const alive = opts.isAlive ?? isProcessAlive;
  ensureStateDir(cwd, stateDir);

  const existing = readLock(cwd, stateDir);
  if (existing && !opts.force && alive(existing.pid)) {
    throw new LockError(
      `another kalfa run is already active in this repository:\n` +
        `  run ${existing.runId}, pid ${existing.pid}, started ${existing.startedAt}\n` +
        `Two runs in one working tree corrupt each other's commits and state.\n` +
        `Wait for it, stop that process, or pass --force if you are certain it is gone.`,
      existing,
    );
  }

  const info: LockInfo = {
    pid: process.pid,
    runId: opts.runId,
    startedAt: new Date().toISOString(),
    command: opts.command,
  };
  writeFileSync(lockPath(cwd, stateDir), JSON.stringify(info, null, 2), 'utf8');

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      // Only drop the lock if it is still ours — a --force takeover means
      // someone else owns it now, and releasing would free it wrongly.
      const current = readLock(cwd, stateDir);
      if (current?.pid === process.pid) unlinkSync(lockPath(cwd, stateDir));
    } catch {
      // A stale lock is recoverable; throwing here is not worth it.
    }
  };
}
