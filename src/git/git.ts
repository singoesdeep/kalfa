import { execFileSync } from 'node:child_process';

/**
 * Git is Kalfa's undo button. Every guarantee the runner makes — "a failed
 * task never poisons the next one", "you can read what it did in the morning",
 * "nothing is lost" — is really a git guarantee.
 *
 * Nothing here rewrites history or touches a remote. The worst it does is
 * stash, which is recoverable.
 */

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // Capture stderr instead of letting it reach the terminal.
      //
      // execFileSync forwards a child's stderr to the parent's by default, and
      // several of these calls are expected to fail or to complain: probing for
      // a branch that does not exist prints "fatal: Needed a single revision",
      // and on Windows every staging operation emits a CRLF warning per file.
      // Unfiltered, Kalfa's own progress output drowns in git chatter, and a
      // "fatal:" line in the middle of a successful run reads as a crash.
      // Failures still surface — the catch below reads stderr off the error.
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(`git ${args.join(' ')} failed: ${(e.stderr ?? e.message).trim()}`);
  }
}

export function isRepo(cwd: string): boolean {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
  } catch {
    return false;
  }
}

export function currentBranch(cwd: string): string {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

export function headSha(cwd: string): string {
  return git(['rev-parse', 'HEAD'], cwd);
}

/** Porcelain status lines. Empty means a clean tree, untracked files included. */
export function statusLines(cwd: string): string[] {
  return git(['status', '--porcelain', '--untracked-files=all'], cwd)
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

export function isClean(cwd: string): boolean {
  return statusLines(cwd).length === 0;
}

export function hasCommits(cwd: string): boolean {
  try {
    git(['rev-parse', 'HEAD'], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * A content hash of the working tree, including untracked files.
 *
 * This is how Kalfa answers "did the worker actually change anything?".
 * `isClean` cannot answer it: Kalfa's own report files, and the accumulated
 * work of earlier tasks when commit_per_task is off, both leave the tree
 * legitimately dirty. Comparing a tree hash before and after an attempt is
 * exact and independent of both.
 *
 * Staging as a side effect is harmless — every commit path here stages
 * everything anyway.
 */
export function treeHash(cwd: string): string {
  git(['add', '--all'], cwd);
  return git(['write-tree'], cwd);
}

/** The tree of the last commit — the baseline a task's work is measured against. */
export function headTreeHash(cwd: string): string {
  return git(['rev-parse', 'HEAD^{tree}'], cwd);
}

export function createBranch(cwd: string, name: string): void {
  git(['checkout', '-b', name], cwd);
}

export function branchExists(cwd: string, name: string): boolean {
  try {
    git(['rev-parse', '--verify', `refs/heads/${name}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage everything and commit. Returns the new sha, or undefined when the
 * agent produced no change at all — which is a task failure, not a success,
 * and the caller treats it that way.
 */
export function commitAll(cwd: string, message: string): string | undefined {
  git(['add', '--all'], cwd);
  const staged = git(['diff', '--cached', '--name-only'], cwd);
  if (staged.length === 0) return undefined;
  // --no-verify is deliberate: hooks are the user's gates, and Kalfa runs its
  // own configured gates before ever reaching this point. A hook that prompts
  // would hang an unattended run.
  git(['commit', '--no-verify', '-m', message], cwd);
  return headSha(cwd);
}

/**
 * Park abandoned work so the next task starts from a known-good tree.
 * Returns the stash ref for the report; the work is fully recoverable.
 */
export function stashAll(cwd: string, message: string): string | undefined {
  if (isClean(cwd)) return undefined;
  git(['stash', 'push', '--include-untracked', '-m', message], cwd);
  try {
    return git(['rev-parse', 'stash@{0}'], cwd);
  } catch {
    return undefined;
  }
}

/** Names of files changed since a given commit, for the run report. */
export function changedFiles(cwd: string, sinceSha: string): string[] {
  return git(['diff', '--name-only', `${sinceSha}..HEAD`], cwd)
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

/**
 * Files the working tree changes relative to HEAD, untracked included.
 *
 * This is what the reviewer is about to look at, so it is what protected-path
 * detection has to run against — the committed diff is too late.
 */
export function pendingFiles(cwd: string): string[] {
  return statusLines(cwd)
    .map((line) => line.slice(3).trim())
    // Renames appear as "old -> new"; the new path is what was written.
    .map((path) => (path.includes(' -> ') ? path.split(' -> ')[1]! : path))
    .map((path) => path.replace(/^"|"$/g, ''))
    .filter((path) => path.length > 0);
}

export function diffStat(cwd: string, sinceSha: string): string {
  return git(['diff', '--stat', `${sinceSha}..HEAD`], cwd);
}
