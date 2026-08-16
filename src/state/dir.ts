import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const STATE_DIR = '.kalfa';

const IGNORE_BODY = '# Kalfa run state. Not part of your project.\n*\n';

/**
 * Create `.kalfa/` and make it invisible to git.
 *
 * This is not tidiness, it is correctness. Kalfa's own bookkeeping lives
 * inside the repository it is modifying, and three operations would otherwise
 * swallow it or trip over it:
 *
 *   - `git add --all` on commit would commit run state into the user's history
 *   - `git stash --include-untracked` on a blocked task would stash the state
 *     file away mid-run, and the next write would fail with ENOENT
 *   - the clean-tree preflight would count Kalfa's own operator logs as the
 *     user's uncommitted work and refuse to start
 *
 * A `.gitignore` containing `*` inside the directory ignores the directory
 * from within — including itself — so this holds without touching the user's
 * own .gitignore.
 *
 * The ignore file is repaired, not merely created. The documented detached
 * launch redirects stdout to `.kalfa/run.log`, which means an operator creates
 * this directory before Kalfa has ever run; a `.kalfa/` that exists without a
 * working ignore file is exactly the state that failed a run before it began.
 */
export function ensureStateDir(cwd: string, stateDir = STATE_DIR): string {
  const dir = join(cwd, stateDir);
  mkdirSync(dir, { recursive: true });

  const ignorePath = join(dir, '.gitignore');
  if (!ignoresEverything(ignorePath)) writeFileSync(ignorePath, IGNORE_BODY, 'utf8');
  return dir;
}

function ignoresEverything(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .some((line) => line.trim() === '*');
  } catch {
    return false;
  }
}

/**
 * Everything one run leaves behind, beyond the shared state and journal files:
 * `.kalfa/runs/<run-id>/`. Keyed by run id so a resumed run appends to its own
 * evidence and a new run never overwrites the last one's.
 */
export function runDir(cwd: string, runId: string, stateDir = STATE_DIR): string {
  ensureStateDir(cwd, stateDir);
  const dir = join(cwd, stateDir, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Is this path inside Kalfa's own state directory?
 *
 * Used to keep Kalfa's bookkeeping out of dirty-tree reports. The gitignore
 * normally handles this, but a `.kalfa/` path that was committed before the
 * ignore existed stays tracked forever, and that must not strand a run.
 */
export function isStatePath(path: string, stateDir = STATE_DIR): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const prefix = `${stateDir.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  return normalized === stateDir || normalized.startsWith(prefix);
}

/** A path under `cwd` written the way git and humans both read it. */
export function repoRelative(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel.split(sep).join('/');
}
