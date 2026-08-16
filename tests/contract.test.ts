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
    expect(AUTONOMY_CONTRACT).toMatch(/Architecture Decision Record/);
    expect(AUTONOMY_CONTRACT).toMatch(/Writing the record IS the approval process/);
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

/**
 * Continuity is the whole answer to "what happens when context fills": it
 * never does, because nothing accumulates. The price is that each task is
 * amnesiac, so the durable artifacts have to be handed over explicitly.
 */
describe('continuity between tasks', () => {
  it('tells the first task it is the first', () => {
    expect(taskPrompt(task, [], [])).toContain('this is the first task');
  });

  it('lists what already landed, so a task can find its predecessors', () => {
    const prompt = taskPrompt(task, [], [
      { id: 'T0', title: 'Add the config loader' },
      { id: 'T1', title: 'Wire it into startup' },
    ]);
    expect(prompt).toContain('T0: Add the config loader');
    expect(prompt).toContain('T1: Wire it into startup');
  });

  it('is explicit that the agent has no memory of them', () => {
    const prompt = taskPrompt(task, [], [{ id: 'T0', title: 'earlier' }]);
    expect(prompt).toMatch(/NO memory/);
    expect(prompt).toMatch(/git log/);
  });

  it('points every task at the ADR index, which stays small as records pile up', () => {
    const prompt = taskPrompt(task, [], []);
    expect(prompt).toMatch(/Read .docs\/adr\/README\.md. before you start/);
    expect(prompt).toMatch(/supersede it explicitly/);
  });

  it('carries the ADR instructions when given them', () => {
    const prompt = taskPrompt(task, [], [], 'WRITE-ADR-HERE');
    expect(prompt).toContain('## Recording decisions');
    expect(prompt).toContain('WRITE-ADR-HERE');
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
    expect(prompt).toMatch(/fix it in place/i);
    expect(prompt).toMatch(/do not start over/i);
  });

  it('points the amnesiac retry at the working tree, its only record', () => {
    const prompt = retryPrompt(task, 2, [{ kind: 'gate', source: 'test', detail: 'x' }]);
    expect(prompt).toMatch(/NO memory of it/);
    expect(prompt).toMatch(/git diff HEAD/);
    expect(prompt).toMatch(/stopped halfway/);
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

/**
 * Reproduced twice in live runs: asked to review a correct fix for a failing
 * test, the reviewer reported as a blocker that the test file had been
 * weakened — when git showed it untouched. One fabricated blocker is enough
 * to burn a task's attempts and stash correct work.
 */
describe('reviewPrompt guards against fabricated cheating findings', () => {
  it('requires the file to be confirmed present in the diff first', () => {
    const prompt = reviewPrompt(task, []);
    expect(prompt).toMatch(/git diff HEAD --name-only/);
    expect(prompt).toMatch(/If it is not there, that file was NOT touched/);
  });

  it('requires the offending line to be quoted', () => {
    expect(reviewPrompt(task, [])).toMatch(/Quote the offending line from the diff/);
  });

  it('states the cost of getting it wrong, not just the rule', () => {
    expect(reviewPrompt(task, [])).toMatch(/fabricated\s+blocker throws away correct work/);
  });
});
