import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Create `.kalfa/` and make it invisible to git.
 *
 * This is not tidiness, it is correctness. Kalfa's own bookkeeping lives
 * inside the repository it is modifying, and two operations in the run loop
 * would otherwise swallow it:
 *
 *   - `git add --all` on commit would commit run state into the user's history
 *   - `git stash --include-untracked` on a blocked task would stash the state
 *     file away mid-run, and the next write would fail with ENOENT
 *
 * A `.gitignore` containing `*` inside the directory ignores the directory
 * from within, so this holds without touching the user's own .gitignore.
 */
export function ensureStateDir(cwd: string, stateDir = '.kalfa'): string {
  const dir = join(cwd, stateDir);
  mkdirSync(dir, { recursive: true });

  const ignorePath = join(dir, '.gitignore');
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, '# Kalfa run state. Not part of your project.\n*\n', 'utf8');
  }
  return dir;
}
