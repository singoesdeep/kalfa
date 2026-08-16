import { describe, expect, it } from 'vitest';
import { blockingFailures, gatesForTask, runGates, trimOutput } from '../src/gates/gates.js';
import { GateSchema } from '../src/config/schema.js';

const gate = (over: Record<string, unknown>) =>
  GateSchema.parse({ name: 'g', run: 'echo hi', ...over });

describe('trimOutput', () => {
  it('keeps short output untouched', () => {
    expect(trimOutput('  hello  ', 100)).toBe('hello');
  });

  it('keeps the tail, where compilers put the errors', () => {
    const text = `${'a'.repeat(200)}THE ERROR`;
    const trimmed = trimOutput(text, 20);
    expect(trimmed).toContain('THE ERROR');
    expect(trimmed).toContain('characters trimmed');
    expect(trimmed.startsWith('a'.repeat(20))).toBe(false);
  });
});

describe('runGates', () => {
  it('runs gates in order and reports success', async () => {
    const results = await runGates(
      [gate({ name: 'first', run: 'echo one' }), gate({ name: 'second', run: 'echo two' })],
      process.cwd(),
    );
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ['first', true],
      ['second', true],
    ]);
    expect(results[0]?.output).toContain('one');
  });

  it('skips later gates after a required failure, to avoid cascade noise', async () => {
    const results = await runGates(
      [
        gate({ name: 'typecheck', run: 'exit 3' }),
        gate({ name: 'test', run: 'echo should-not-run' }),
      ],
      process.cwd(),
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.exitCode).toBe(3);
    expect(results[1]?.skipped).toBe(true);
    expect(results[1]?.output).toBe('');
  });

  it('continues past a non-required failure', async () => {
    const results = await runGates(
      [
        gate({ name: 'lint', run: 'exit 1', required: false }),
        gate({ name: 'test', run: 'echo ran' }),
      ],
      process.cwd(),
    );
    expect(results[1]?.skipped).toBeUndefined();
    expect(results[1]?.ok).toBe(true);
  });

  it('captures stderr, since that is where failures usually speak', async () => {
    const results = await runGates([gate({ name: 'g', run: 'echo boom 1>&2; exit 1' })], process.cwd());
    expect(results[0]?.output).toContain('boom');
  });
});

describe('blockingFailures', () => {
  it('ignores failures from non-required gates', () => {
    const gates = [gate({ name: 'lint', required: false }), gate({ name: 'test' })];
    const failures = blockingFailures(
      [
        { name: 'lint', ok: false, exitCode: 1, output: 'x', durationMs: 1 },
        { name: 'test', ok: false, exitCode: 1, output: 'y', durationMs: 1 },
      ],
      gates,
    );
    expect(failures.map((f) => f.name)).toEqual(['test']);
  });

  it('ignores gates that never ran', () => {
    const gates = [gate({ name: 'test' })];
    const failures = blockingFailures(
      [{ name: 'test', ok: false, exitCode: -1, output: '', durationMs: 0, skipped: true }],
      gates,
    );
    expect(failures).toHaveLength(0);
  });
});

describe('gatesForTask', () => {
  it('returns all gates when the task names none', () => {
    const all = [gate({ name: 'a' }), gate({ name: 'b' })];
    expect(gatesForTask(all)).toHaveLength(2);
  });

  it('selects named gates in config order, not the order named', () => {
    const all = [gate({ name: 'a' }), gate({ name: 'b' }), gate({ name: 'c' })];
    expect(gatesForTask(all, ['c', 'a']).map((g) => g.name)).toEqual(['a', 'c']);
  });
});
