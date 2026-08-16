import { describe, expect, it } from 'vitest';
import { describeAbort, parseClaudeResult, quoteForCmd } from '../src/agents/provider.js';

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
