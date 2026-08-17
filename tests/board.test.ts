import { describe, expect, it } from 'vitest';
import { renderBoard, renderBoardPlain } from '../src/board/board.js';
import { PlanSchema } from '../src/plan/schema.js';
import { validateSpec, specPrompt } from '../src/spec/spec.js';
import type { RunRecord } from '../src/types.js';

const plan = PlanSchema.parse({
  version: 1,
  goal: 'Add rate limiting',
  tasks: [
    { id: 'T1', title: 'Limiter' },
    { id: 'T2', title: 'Wire it up', deps: ['T1'] },
    { id: 'T3', title: 'Docs', deps: ['T2'] },
  ],
});

const run: RunRecord = {
  schemaVersion: 1,
  runId: '20260816-031500',
  startedAt: '2026-08-16T03:15:00.000Z',
  planPath: 'kalfa.plan.json',
  branch: 'kalfa/20260816-031500',
  tasks: {
    T1: { id: 'T1', status: 'done', attempts: [], commit: 'abcdef1234', costUsd: 0.42, durationMs: 1 },
    T2: {
      id: 'T2',
      status: 'blocked',
      attempts: [
        {
          attempt: 1,
          agentCostUsd: 0.3,
          reviewCostUsd: 0,
          durationMs: 1,
          gates: [{ name: 'test', ok: false, exitCode: 1, output: 'x', durationMs: 1 }],
          reviewFindings: 0,
          blockingFindings: 0,
          outcome: 'gate_failed',
        },
      ],
      reason: 'no attempt passed verification in 3 attempts',
      stashRef: 'deadbeef99',
      costUsd: 0.3,
      durationMs: 1,
    },
  },
};

describe('renderBoard', () => {
  it('shows every planned task, including ones the run never reached', () => {
    const board = renderBoard(plan, run);
    expect(board).toContain('T1: Limiter');
    expect(board).toContain('T2: Wire it up');
    // T3 has no state record at all and must still appear, as pending.
    expect(board).toContain('T3: Docs');
    expect(board).toContain('| pending |');
  });

  it('summarises progress and total cost at a glance', () => {
    const board = renderBoard(plan, run);
    expect(board).toContain('1/3 done');
    expect(board).toContain('1 blocked');
    expect(board).toContain('$0.7200');
  });

  it('tells you how to recover work parked by a blocked task', () => {
    const board = renderBoard(plan, run);
    expect(board).toContain('## Needs you');
    expect(board).toContain('no attempt passed verification');
    expect(board).toContain('git stash');
    expect(board).toContain('gate `test` failed');
  });

  // A blocked task's records live inside the stash, so a reader who goes to
  // docs/adr/ finds nothing and concludes the worker never reasoned about it.
  // It usually did, at length — that is what a block is made of.
  it('points at the reasoning a blocked task left behind', () => {
    const withAdrs: RunRecord = {
      ...run,
      tasks: {
        ...run.tasks,
        T2: { ...run.tasks['T2']!, adrsWritten: 2 },
      },
    };
    const board = renderBoard(plan, withAdrs);
    expect(board).toContain('**Decisions recorded:** 2');
    expect(board).toContain('inside the stash below');
  });

  it('offers the resume command while anything is outstanding', () => {
    expect(renderBoard(plan, run)).toContain('kalfa run --run-id 20260816-031500');
  });

  it('does not offer a resume once everything is done', () => {
    const finished: RunRecord = {
      ...run,
      finishedAt: '2026-08-16T05:00:00.000Z',
      tasks: Object.fromEntries(
        plan.tasks.map((t) => [
          t.id,
          { id: t.id, status: 'done' as const, attempts: [], costUsd: 0, durationMs: 0 },
        ]),
      ),
    };
    const board = renderBoard(plan, finished);
    expect(board).toContain('3/3 done');
    expect(board).not.toContain('--run-id');
    expect(board).toContain('Nothing outstanding');
  });

  it('warns that it is regenerated, so nobody edits it by hand', () => {
    expect(renderBoard(plan, run)).toMatch(/edits here are lost/);
  });
});

describe('renderBoardPlain', () => {
  it('renders one aligned line per task with a status marker', () => {
    const lines = renderBoardPlain(plan, run).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('[x]');
    expect(lines[1]).toContain('[!]');
    expect(lines[2]).toContain('[ ]');
    expect(lines[0]).toContain('abcdef12');
  });
});

describe('spec validation', () => {
  const good = {
    prd: '# PRD\n\n## Success criteria\n- p95 under 200ms\n'.padEnd(60, ' '),
    spec: '# Spec\n\n## Behaviour\nthings\n\n## Non-goals\n- not caching\n'.padEnd(60, ' '),
  };

  it('accepts a document with behaviour, non-goals and success criteria', () => {
    expect(validateSpec(good)).toEqual([]);
  });

  it('rejects a spec with no non-goals — the reviewer needs them for scope creep', () => {
    const problems = validateSpec({ ...good, spec: '# Spec\n\n## Behaviour\nthings\n' });
    expect(problems.join(' ')).toMatch(/Non-goals/);
    expect(problems.join(' ')).toMatch(/scope creep/);
  });

  it('rejects a PRD with no success criteria', () => {
    const problems = validateSpec({ ...good, prd: '# PRD\n\n## Problem\nit is slow\n' });
    expect(problems.join(' ')).toMatch(/Success criteria/);
  });
});

describe('specPrompt', () => {
  it('states that the audience cannot ask questions', () => {
    expect(specPrompt('g', [])).toMatch(/audience is not human/i);
    expect(specPrompt('g', [])).toMatch(/cannot ask you\s+anything/);
  });

  it('demands observable success criteria rather than aspirations', () => {
    expect(specPrompt('g', [])).toMatch(/Observable, not/);
  });

  it('keeps sequencing out of the spec — that is the plan\'s job', () => {
    expect(specPrompt('g', [])).toMatch(/Do not write implementation steps/);
  });
});

/**
 * The codex CLI does not report per-run cost, so a run with a codex reviewer
 * spends more than it reports. Presenting that total as if it were the bill
 * would be a lie, and `max_run_cost_usd` is enforced against it.
 */
describe('cost is never presented as complete when it is not', () => {
  const incomplete: RunRecord = { ...run, costIncomplete: true };

  it('marks the total as a floor', () => {
    expect(renderBoard(plan, incomplete)).toContain('$0.7200+');
  });

  it('says why, rather than leaving a bare plus sign', () => {
    const board = renderBoard(plan, incomplete);
    expect(board).toMatch(/Costs are a FLOOR/);
    expect(board).toMatch(/codex CLI does not report per-run/);
  });

  it('leaves a complete total unqualified', () => {
    const board = renderBoard(plan, run);
    expect(board).toContain('$0.7200');
    expect(board).not.toContain('$0.7200+');
    expect(board).not.toMatch(/FLOOR/);
  });
});

/**
 * A live multi-task run completed two tasks and wrote no decision records at
 * all. That is the correct outcome when the spec left nothing to assume — and
 * indistinguishable, from the outside, from assumptions made silently. Kalfa
 * cannot tell which; it can refuse to let the question go unasked.
 */
describe('decision records that were never written', () => {
  const done = (id: string, adrsWritten?: number) => ({
    id,
    status: 'done' as const,
    attempts: [],
    costUsd: 0,
    durationMs: 0,
    ...(adrsWritten === undefined ? {} : { adrsWritten }),
  });

  it('says so when a run completed tasks and recorded nothing', () => {
    const record: RunRecord = {
      ...run,
      tasks: { T1: done('T1', 0), T2: done('T2', 0), T3: done('T3', 0) },
    };
    const board = renderBoard(plan, record);
    expect(board).toContain('## No decisions were recorded');
    expect(board).toContain('3 task(s) completed');
    expect(board).toMatch(/right outcome if the spec left nothing open/);
  });

  it('stays quiet when decisions were recorded', () => {
    const record: RunRecord = {
      ...run,
      tasks: { T1: done('T1', 2), T2: done('T2', 0), T3: done('T3', 0) },
    };
    expect(renderBoard(plan, record)).not.toContain('No decisions were recorded');
  });

  it('stays quiet when nothing completed, where zero records means nothing', () => {
    const record: RunRecord = { ...run, tasks: {} };
    expect(renderBoard(plan, record)).not.toContain('No decisions were recorded');
  });
});
