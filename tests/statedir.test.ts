import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureStateDir, isStatePath, repoRelative, runDir } from '../src/state/dir.js';
import * as git from '../src/git/git.js';

/**
 * The detached-launch regression.
 *
 * The documented way to start an unattended run redirects stdout and stderr
 * into `.kalfa/`, which means the operator creates that directory — and its
 * first two files — before Kalfa has ever run in the repository. On the first
 * real-project run that was enough to kill it before a single task started:
 *
 *   kalfa: working tree is dirty — commit or stash first…
 *     ?? .kalfa/run.err
 *
 * Kalfa's own operator logs are not the user's uncommitted work.
 */

let dir: string;

const run = (...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kalfa-statedir-'));
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n', 'utf8');
  run('add', '.');
  run('commit', '-q', '-m', 'initial');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureStateDir', () => {
  it('leaves the tree clean when the operator redirected logs into .kalfa first', () => {
    // Exactly the documented Start-Process / nohup sequence: make the
    // directory so redirection has a destination, then let the files appear.
    mkdirSync(join(dir, '.kalfa'), { recursive: true });
    writeFileSync(join(dir, '.kalfa', 'run.log'), '', 'utf8');
    writeFileSync(join(dir, '.kalfa', 'run.err'), '', 'utf8');
    expect(git.isClean(dir)).toBe(false);

    ensureStateDir(dir);

    expect(git.statusLines(dir)).toEqual([]);
    expect(git.isClean(dir)).toBe(true);
  });

  it('repairs an ignore file that does not actually ignore anything', () => {
    mkdirSync(join(dir, '.kalfa'), { recursive: true });
    writeFileSync(join(dir, '.kalfa', '.gitignore'), '# nothing here\n', 'utf8');
    writeFileSync(join(dir, '.kalfa', 'run.log'), 'output\n', 'utf8');

    ensureStateDir(dir);

    expect(readFileSync(join(dir, '.kalfa', '.gitignore'), 'utf8')).toContain('*');
    expect(git.isClean(dir)).toBe(true);
  });

  it('does not touch an ignore file that already works', () => {
    const path = join(dir, '.kalfa', '.gitignore');
    ensureStateDir(dir);
    writeFileSync(path, '# hand-edited\n*\n!keep-me.json\n', 'utf8');

    ensureStateDir(dir);

    expect(readFileSync(path, 'utf8')).toContain('!keep-me.json');
  });

  it('still reports the user\'s own uncommitted work', () => {
    ensureStateDir(dir);
    writeFileSync(join(dir, 'mine.txt'), 'unfinished\n', 'utf8');

    expect(git.statusLines(dir).map((l) => l.slice(3))).toEqual(['mine.txt']);
  });
});

describe('isStatePath', () => {
  it('recognises the state directory in either slash style', () => {
    expect(isStatePath('.kalfa/run.err')).toBe(true);
    expect(isStatePath('.kalfa\\runs\\20260816-155225\\artifacts\\T1\\1\\diff.patch')).toBe(true);
    expect(isStatePath('.kalfa')).toBe(true);
  });

  it('does not catch a path that merely starts with the same letters', () => {
    expect(isStatePath('.kalfa-notes/file.txt')).toBe(false);
    expect(isStatePath('src/.kalfa.ts')).toBe(false);
  });
});

describe('runDir', () => {
  it('gives each run its own directory, inside the ignored state directory', () => {
    const first = runDir(dir, '20260816-155225');
    const second = runDir(dir, '20260816-181500');

    expect(first).not.toBe(second);
    expect(repoRelative(dir, first)).toBe('.kalfa/runs/20260816-155225');
    // Artifacts must never show up as the user's dirty tree either.
    writeFileSync(join(first, 'scratch.txt'), 'x', 'utf8');
    expect(git.isClean(dir)).toBe(true);
  });
});
