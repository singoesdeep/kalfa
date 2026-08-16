import { describe, expect, it } from 'vitest';
import {
  extractJson,
  generatePlan,
  interviewPrompt,
  planPrompt,
  plannerAgent,
  askQuestions,
  PlanGenerationError,
} from '../src/plan/generate.js';
import type { AgentInvoker } from '../src/agents/provider.js';
import type { AgentRun } from '../src/types.js';

function stubPlanner(replies: string[], ok = true): AgentInvoker {
  let call = 0;
  return {
    label: 'stub',
    provider: 'claude',
    invoke: async (): Promise<AgentRun> => {
      const text = replies[Math.min(call, replies.length - 1)]!;
      call += 1;
      return { text, ok, costUsd: 0.05, durationMs: 10 };
    },
  } as unknown as AgentInvoker;
}

const validPlan = JSON.stringify({
  version: 1,
  goal: 'do the thing',
  tasks: [{ id: 'T1', title: 'first', details: 'd', deps: [], files: [], acceptance: ['a'] }],
});

describe('plannerAgent', () => {
  it('cannot write, and that is enforced by the CLI rather than by instruction', () => {
    const agent = plannerAgent();
    expect(agent.disallowed_tools).toContain('Edit');
    expect(agent.disallowed_tools).toContain('Write');
  });
});

describe('extractJson', () => {
  it('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON inside a fence, which models emit despite being told not to', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```\n')).toEqual({ a: 1 });
  });

  it('parses JSON surrounded by prose', () => {
    expect(extractJson('I looked around. {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it('returns undefined when there is no JSON at all', () => {
    expect(extractJson('no json here')).toBeUndefined();
  });
});

describe('generatePlan', () => {
  it('returns a valid plan on the first attempt', async () => {
    const result = await generatePlan(stubPlanner([validPlan]), {
      goal: 'g',
      cwd: process.cwd(),
      answers: [],
    });
    expect(result.attempts).toBe(1);
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.costUsd).toBeCloseTo(0.05);
  });

  it('feeds validation errors back and accepts the repaired plan', async () => {
    const broken = JSON.stringify({
      version: 1,
      goal: 'g',
      tasks: [{ id: 'T1', title: 'a', deps: ['T99'] }],
    });
    const seen: string[] = [];
    const result = await generatePlan(stubPlanner([broken, validPlan]), {
      goal: 'g',
      cwd: process.cwd(),
      answers: [],
      onAttempt: (_attempt, errors) => {
        if (errors) seen.push(errors);
      },
    });

    expect(result.attempts).toBe(2);
    expect(seen[0]).toContain('unknown task');
    expect(result.costUsd).toBeCloseTo(0.1); // both attempts are paid for
  });

  it('refuses to return a plan that never validates, rather than a broken one', async () => {
    const broken = JSON.stringify({ version: 1, goal: 'g', tasks: [] });
    await expect(
      generatePlan(stubPlanner([broken]), { goal: 'g', cwd: process.cwd(), answers: [] }),
    ).rejects.toBeInstanceOf(PlanGenerationError);
  });

  it('keeps the last raw output on failure, so the work is not lost', async () => {
    const error = await generatePlan(stubPlanner(['not json at all']), {
      goal: 'g',
      cwd: process.cwd(),
      answers: [],
      maxAttempts: 1,
    }).catch((e: unknown) => e as PlanGenerationError);

    expect(error).toBeInstanceOf(PlanGenerationError);
    expect((error as PlanGenerationError).lastOutput).toBe('not json at all');
  });

  it('stops after maxAttempts rather than looping', async () => {
    let calls = 0;
    const counting = {
      label: 'stub',
      provider: 'claude',
      invoke: async (): Promise<AgentRun> => {
        calls += 1;
        return { text: 'nope', ok: true, costUsd: 0, durationMs: 1 };
      },
    } as unknown as AgentInvoker;

    await generatePlan(counting, {
      goal: 'g',
      cwd: process.cwd(),
      answers: [],
      maxAttempts: 2,
    }).catch(() => undefined);
    expect(calls).toBe(2);
  });
});

describe('askQuestions', () => {
  it('parses a question list and caps it at the requested maximum', async () => {
    const payload = JSON.stringify({
      questions: [
        { id: 'q1', question: 'a?', why: 'w', suggested: 's' },
        { id: 'q2', question: 'b?', why: 'w', suggested: 's' },
        { id: 'q3', question: 'c?', why: 'w', suggested: 's' },
      ],
    });
    const result = await askQuestions(stubPlanner([payload]), 'g', process.cwd(), 2);
    expect(result.questions).toHaveLength(2);
  });

  it('treats no questions as a valid outcome', async () => {
    const result = await askQuestions(stubPlanner(['{"questions":[]}']), 'g', process.cwd(), 5);
    expect(result.questions).toEqual([]);
  });

  it('falls through to generation when the question list is unreadable', async () => {
    // Better to plan with no answers than to burn a round-trip re-asking.
    const result = await askQuestions(stubPlanner(['I have no questions!']), 'g', process.cwd(), 5);
    expect(result.questions).toEqual([]);
  });

  it('throws when the planner process itself fails', async () => {
    await expect(
      askQuestions(stubPlanner(['x'], false), 'g', process.cwd(), 5),
    ).rejects.toBeInstanceOf(PlanGenerationError);
  });
});

describe('prompts', () => {
  it('tells the interviewer this is its only chance to ask', () => {
    const prompt = interviewPrompt('build a thing', 6);
    expect(prompt).toMatch(/ONLY time you may ask/);
    expect(prompt).toMatch(/AT MOST 6 questions/);
    expect(prompt).toMatch(/no follow-up round/i);
  });

  it('requires a real suggested answer, since most users press Enter', () => {
    expect(interviewPrompt('g', 3)).toMatch(/not "it depends"/);
  });

  it('warns the planner that vagueness becomes an unattended assumption', () => {
    expect(planPrompt('g', [])).toMatch(/DECISIONS\.md/);
    expect(planPrompt('g', [])).toMatch(/CANNOT ask questions/);
  });

  it('carries answers into the planning prompt, marking accepted defaults', () => {
    const prompt = planPrompt('g', [
      { question: 'Which store?', answer: 'postgres', defaulted: true },
    ]);
    expect(prompt).toContain('Which store?');
    expect(prompt).toContain('postgres');
    expect(prompt).toContain('accepted your suggestion');
  });

  it('quotes validation errors verbatim when repairing', () => {
    const prompt = planPrompt('g', [], 'tasks.0.deps: unknown task "T9"');
    expect(prompt).toContain('unknown task "T9"');
    expect(prompt).toMatch(/Do not restructure the rest/);
  });
});
