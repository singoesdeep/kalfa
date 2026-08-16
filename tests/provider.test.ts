import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexOutcome,
  describeAbort,
  parseClaudeResult,
  quoteForCmd,
  runProcess,
} from '../src/agents/provider.js';

/**
 * The exit code lies.
 *
 * `claude -p` returns 0 when it runs out of turns or context: the process
 * succeeded, the task did not. Judging by exit code alone marks a
 * half-finished task complete, and if its gates happen to pass, commits the
 * partial work. These tests pin the distinction.
 */
describe('parseClaudeResult', () => {
  it('reads text, cost and session id from a successful run', () => {
    const result = parseClaudeResult(
      JSON.stringify({
        result: 'did the thing',
        total_cost_usd: 0.42,
        session_id: 'abc',
        subtype: 'success',
        is_error: false,
      }),
    );
    expect(result.text).toBe('did the thing');
    expect(result.costUsd).toBe(0.42);
    expect(result.sessionId).toBe('abc');
    expect(result.aborted).toBe(false);
  });

  it('treats running out of turns as an abort, not a success', () => {
    const result = parseClaudeResult(
      JSON.stringify({ result: 'partial', subtype: 'error_max_turns', is_error: true }),
    );
    expect(result.aborted).toBe(true);
    expect(result.subtype).toBe('error_max_turns');
  });

  it('treats an error subtype as an abort even when is_error is absent', () => {
    const result = parseClaudeResult(JSON.stringify({ result: 'x', subtype: 'error_during_execution' }));
    expect(result.aborted).toBe(true);
  });

  it('treats is_error as an abort even when the subtype says success', () => {
    const result = parseClaudeResult(JSON.stringify({ result: 'x', subtype: 'success', is_error: true }));
    expect(result.aborted).toBe(true);
  });

  it('defaults a missing subtype to success rather than failing the task', () => {
    expect(parseClaudeResult(JSON.stringify({ result: 'x' })).aborted).toBe(false);
  });

  it('keeps unparseable output as text instead of losing the work', () => {
    const result = parseClaudeResult('not json');
    expect(result.text).toBe('not json');
    expect(result.subtype).toBe('unparseable');
    // Not an abort: the run may well have succeeded and printed plain text.
    expect(result.aborted).toBe(false);
  });
});

describe('describeAbort', () => {
  it('explains max turns in terms the retry can act on', () => {
    const text = describeAbort('error_max_turns');
    expect(text).toMatch(/incomplete/);
    expect(text).toMatch(/too large|max_turns/);
  });

  it('falls back to naming an unrecognised subtype', () => {
    expect(describeAbort('error_something_new')).toContain('error_something_new');
  });
});

/**
 * On Windows these CLIs are .cmd shims, so a shell is required — and passing
 * an args array with a shell concatenates them unescaped. That is not just
 * Node's deprecation warning being fussy: the temp path handed to
 * `--output-schema` contains the username, so any account with a space in it
 * would have sent the reviewer a mangled path.
 */
describe('quoteForCmd', () => {
  it('leaves ordinary arguments alone', () => {
    expect(quoteForCmd('--sandbox')).toBe('--sandbox');
    expect(quoteForCmd('read-only')).toBe('read-only');
    const plain = String.raw`C:\Users\singo\tmp\schema.json`;
    expect(quoteForCmd(plain)).toBe(plain);
  });

  it('quotes a path containing a space, which is the case that broke', () => {
    const spaced = String.raw`C:\Users\John Smith\tmp\schema.json`;
    expect(quoteForCmd(spaced)).toBe(`"${spaced}"`);
  });

  it('quotes cmd.exe metacharacters', () => {
    for (const arg of ['a&b', 'a|b', 'a>b', 'a(b)', 'a%b%', 'a^b', 'a!b']) {
      expect(quoteForCmd(arg), arg).toBe(`"${arg}"`);
    }
  });
});

/**
 * A child that exits and leaves its pipes behind.
 *
 * This is the failure that hung a live run. `codex exec` finished its review,
 * wrote the answer to disk, and did not exit; on Windows it was a grandchild
 * of the shell wrapper, so it held the inherited stdout and stderr open. The
 * runner resolved on `close`, which waits on the pipes rather than the
 * process, so it waited — through its own 30-minute timeout, which killed the
 * shell and not the agent, and therefore closed nothing.
 *
 * These drive the same shape with plain node processes: a child that spawns a
 * long-lived grandchild inheriting its stdio, then exits or hangs.
 */
describe('runProcess: a lingering grandchild must not hold the run', () => {
  let dir: string;

  /**
   * A script, not an inline `-e`. On Windows runProcess builds one command
   * line for cmd.exe, and a multi-line program does not survive that — which
   * is the same reason prompts travel on stdin.
   */
  const script = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body, 'utf8');
    return path;
  };

  /** Hands stdio to a grandchild that outlives it, then exits. */
  const leaky = (grandchildMs: number, parentExitMs: number): string =>
    `const { spawn } = require('child_process');
     spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${grandchildMs})'],
       { stdio: 'inherit', detached: true }).unref();
     console.log('parent done');
     setTimeout(() => process.exit(0), ${parentExitMs});`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kalfa-proc-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A grandchild may still hold the directory open on Windows.
    }
  });

  it('settles when the child exits, without waiting for pipes it no longer owns', async () => {
    const path = script('leaks.cjs', leaky(30_000, 0));
    const started = Date.now();
    const result = await runProcess(process.execPath, [path], '', {
      cwd: dir,
      timeoutMs: 60_000,
    });

    // The grandchild holds the pipes for 30s. Resolving on `close` alone
    // would have waited out all of it.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('parent done');
  }, 45_000);

  it('still honours the timeout when the child itself will not exit', async () => {
    const path = script('hangs.cjs', leaky(30_000, 30_000));
    const started = Date.now();
    const result = await runProcess(process.execPath, [path], '', {
      cwd: dir,
      timeoutMs: 1500,
    });

    // Before killTree the timeout killed the shell and left the agent holding
    // the pipes, so this never settled at all.
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 45_000);
});

/**
 * An agent that answers and then will not leave.
 *
 * `codex exec --output-last-message` writes the final message when the task
 * is done, which a live run showed is not the same event as the process
 * exiting: the reviewer finished a minute in, wrote its findings, and stayed.
 * Kalfa waited out the full 30-minute timeout and was about to block a task
 * whose review had passed, with the review on disk the whole time.
 */
describe('codexOutcome', () => {
  const base = { stdout: '', code: 0, timedOut: false, timeoutMs: 1000, stderr: '' };

  it('prefers the written answer over stdout', () => {
    const out = codexOutcome({ ...base, answerFile: '{"findings":[]}\n', stdout: 'noise' });
    expect(out.text).toBe('{"findings":[]}');
    expect(out.ok).toBe(true);
  });

  it('falls back to stdout when no answer file was written', () => {
    expect(codexOutcome({ ...base, stdout: '  hello  ' }).text).toBe('hello');
  });

  it('accepts a timeout whose answer was already written, and says so', () => {
    const out = codexOutcome({
      ...base,
      answerFile: '{"findings":[]}',
      code: null,
      timedOut: true,
    });
    expect(out.ok).toBe(true);
    expect(out.lingered).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.note).toContain('did not exit');
  });

  // Without a file there is no evidence the agent finished anything, so a
  // timeout is what it has always been: the review did not happen.
  it('still fails a timeout that produced no answer', () => {
    const out = codexOutcome({ ...base, code: null, timedOut: true, stdout: 'partial chatter' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('timed out');
    expect(out.note).toBeUndefined();
  });

  it('treats an empty answer file as no answer', () => {
    const out = codexOutcome({ ...base, answerFile: '   \n', code: null, timedOut: true });
    expect(out.ok).toBe(false);
  });

  // Narrow on purpose: only a lingering process is forgiven. A non-zero exit
  // is a different claim about what happened and there is no evidence for
  // treating it as fine.
  it('does not forgive a non-zero exit just because a file exists', () => {
    const out = codexOutcome({ ...base, answerFile: '{"findings":[]}', code: 1, stderr: 'boom' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('codex exited 1');
  });
});
