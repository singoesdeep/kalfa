import { describe, expect, it } from 'vitest';
import { TaskSchema } from '../src/plan/schema.js';
import { AUTONOMY_CONTRACT, retryPrompt, reviewPrompt, taskPrompt } from '../src/prompts/contract.js';

const task = TaskSchema.parse({
  id: 'T1',
  title: 'Add rate limiting',
  details: 'Limit the webhook dispatcher to 10 rps.',
  acceptance: ['Requests over the limit get 429', 'Limit is configurable'],
  files: ['src/dispatch.ts'],
});

/**
 * These assertions are the product, not boilerplate. The contract is the only
 * thing standing between an unattended run and a worker that stops to ask.
 */
describe('autonomy contract', () => {
  it('forbids questions', () => {
    expect(AUTONOMY_CONTRACT).toMatch(/NEVER ask a question/);
  });

  it('gives ambiguity a destination other than the human', () => {
    expect(AUTONOMY_CONTRACT).toMatch(/DECISIONS\.md/);
    expect(AUTONOMY_CONTRACT).toMatch(/Reversal cost/);
  });

  it('restricts blocking to irreversible actions, and says so explicitly', () => {
    expect(AUTONOMY_CONTRACT).toMatch(/IRREVERSIBLE/);
    expect(AUTONOMY_CONTRACT).toMatch(/Ambiguous requirements are NOT blockers/);
  });

  it('forbids the obvious way to make gates pass', () => {
    expect(AUTONOMY_CONTRACT).toMatch(/Do not disable, skip, weaken, or delete a test/);
  });
});

describe('taskPrompt', () => {
  it('carries acceptance criteria and gate commands', () => {
    const prompt = taskPrompt(task, ['npm test']);
    expect(prompt).toContain('Requests over the limit get 429');
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('src/dispatch.ts');
  });

  it('says so when no gates are configured, rather than implying none ran', () => {
    expect(taskPrompt(task, [])).toContain('None configured');
  });
});

describe('retryPrompt', () => {
  it('quotes failure output verbatim inside a fence', () => {
    const prompt = retryPrompt(task, 2, [
      { kind: 'gate', source: 'typecheck', detail: "TS2345: Argument of type 'string'" },
    ]);
    expect(prompt).toContain("TS2345: Argument of type 'string'");
    expect(prompt).toContain('Failed gate: typecheck');
    expect(prompt).toContain('attempt 2');
  });

  it('tells the worker to fix in place rather than restart', () => {
    const prompt = retryPrompt(task, 2, [{ kind: 'agent', source: 'claude', detail: 'boom' }]);
    expect(prompt).toMatch(/fix it in place/);
  });

  it('repeats the no-weakening rule where it is most likely to be broken', () => {
    const prompt = retryPrompt(task, 3, [{ kind: 'gate', source: 'test', detail: '1 failing' }]);
    expect(prompt).toMatch(/Do not weaken or delete tests/);
  });
});

describe('reviewPrompt', () => {
  it('asks for cheating specifically, not just correctness', () => {
    const prompt = reviewPrompt(task, ['npm test']);
    expect(prompt).toMatch(/Cheating/);
    expect(prompt).toMatch(/tests deleted, assertions weakened/);
  });

  it('tells the reviewer not to re-report what the gates already cover', () => {
    expect(reviewPrompt(task, ['npm test'])).toMatch(/do not re-report/i);
  });

  it('states that no findings is an acceptable answer', () => {
    expect(reviewPrompt(task, [])).toMatch(/empty[\s\S]*findings array is the correct answer/);
  });
});
