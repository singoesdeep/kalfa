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

  // The schema carries `claim` as a bare nullable string, so the prompt is the
  // only place the two accepted values are stated. If it stops naming them,
  // every finding degrades to "other" and the mechanical check goes quiet
  // without anything failing.
  it('names both claim labels, since the schema no longer constrains them', () => {
    const prompt = reviewPrompt(task, []);
    expect(prompt).toContain('"file_changed"');
    expect(prompt).toContain('"other"');
  });

  it('says what the check does with a file_changed claim, so the label means something', () => {
    expect(reviewPrompt(task, [])).toMatch(/discards it if the file is\s+not there/);
  });
});

/**
 * Attempt 3 used to know only about attempt 2, so a worker could oscillate:
 * fix A breaks the type check, fix B breaks the test, fix A again. Each step
 * looks locally reasonable and the task burns every attempt on two mistakes.
 */
describe('retry history', () => {
  const prior = [
    {
      attempt: 1,
      feedback: [{ kind: 'gate' as const, source: 'typecheck', detail: "TS2345: bad arg\nmore noise" }],
    },
    {
      attempt: 2,
      feedback: [{ kind: 'review' as const, source: 'codex', detail: '[major] race condition' }],
    },
  ];

  it('lists every earlier failure, not just the most recent', () => {
    const prompt = retryPrompt(task, 3, [{ kind: 'gate', source: 'test', detail: 'boom' }], prior);
    expect(prompt).toContain('attempt 1 failed on');
    expect(prompt).toContain('TS2345: bad arg');
    expect(prompt).toContain('attempt 2 failed on');
    expect(prompt).toContain('race condition');
  });

  it('summarises history to one line each, keeping only the current failure in full', () => {
    const prompt = retryPrompt(task, 3, [{ kind: 'gate', source: 'test', detail: 'boom' }], prior);
    // The noise from attempt 1 is dropped; only its first line survives.
    expect(prompt).not.toContain('more noise');
    expect(prompt).toContain('boom');
  });

  it('names the failure mode it exists to prevent', () => {
    const prompt = retryPrompt(task, 3, [{ kind: 'gate', source: 'test', detail: 'x' }], prior);
    expect(prompt).toMatch(/Try a different approach rather than the same one more carefully/);
  });

  it('omits the section entirely on the first retry, when there is no history', () => {
    const prompt = retryPrompt(task, 2, [{ kind: 'gate', source: 'test', detail: 'x' }]);
    expect(prompt).not.toContain('Already tried and failed');
  });
});

/**
 * The reviewer sees a diff and nothing else, so it cannot normally tell that
 * a locally fine change has painted a later task into a corner. Naming what
 * is still to come is cheap; the framing is the hard part, because a reviewer
 * told about future work will otherwise demand it be built now.
 */
describe('reviewPrompt: upcoming plan context', () => {
  const upcoming = [
    { id: 'T7', title: 'Add per-tenant quotas' },
    { id: 'T8', title: 'Expose the limiter over HTTP' },
  ];

  it('names what is still to come', () => {
    const prompt = reviewPrompt(task, [], undefined, upcoming);
    expect(prompt).toContain('T7: Add per-tenant quotas');
    expect(prompt).toContain('T8: Expose the limiter over HTTP');
  });

  it('forbids demanding future work now, which would be scope creep', () => {
    const prompt = reviewPrompt(task, [], undefined, upcoming);
    expect(prompt).toMatch(/context, not scope/);
    expect(prompt).toMatch(/Do NOT ask for any of it to be implemented/);
  });

  it('sets a high bar: impossible or much harder, not merely unimplemented', () => {
    const prompt = reviewPrompt(task, [], undefined, upcoming);
    expect(prompt).toMatch(/actively makes one of them impossible or\s+much harder/);
  });

  it('omits the section on the last task, where nothing follows', () => {
    expect(reviewPrompt(task, [], undefined, [])).not.toContain('Still to come');
  });
});

/**
 * A retry is a fresh session with no memory, so it needs the specification as
 * much as the first attempt does. Without it the worker sees a title and an
 * error message and has to reconstruct the requirement from the diff — which
 * is how a retry confidently fixes the wrong thing.
 */
describe('retryPrompt carries the whole task, not just the failure', () => {
  const prompt = retryPrompt(
    task,
    2,
    [{ kind: 'gate', source: 'test', detail: 'boom' }],
    [],
    ['npm test'],
    'ADR-INSTRUCTIONS-HERE',
  );

  it('repeats the task details', () => {
    expect(prompt).toContain('Limit the webhook dispatcher to 10 rps.');
  });

  it('repeats the acceptance criteria it will be judged against', () => {
    expect(prompt).toContain('Requests over the limit get 429');
    expect(prompt).toContain('Limit is configurable');
  });

  it('repeats the verification commands', () => {
    expect(prompt).toContain('npm test');
  });

  it('carries the decision-record format, which the retry has never seen', () => {
    expect(prompt).toContain('ADR-INSTRUCTIONS-HERE');
  });

  it('still leads with the failure framing rather than reading as a fresh task', () => {
    expect(prompt).toContain('attempt 2');
    expect(prompt).toMatch(/NO memory of it/);
    expect(prompt).toContain('boom');
  });
});
