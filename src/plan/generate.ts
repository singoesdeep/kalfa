import { z } from 'zod';
import { AgentInvoker } from '../agents/provider.js';
import { AgentSchema, type AgentConfig } from '../config/schema.js';
import { PlanSchema, type Plan } from './schema.js';

/**
 * Plan generation: the one part of Kalfa you are supposed to sit through.
 *
 * The design constraint that matters is HOW it asks. Interactive frameworks
 * interrogate you one question at a time, across phases, over hours — that is
 * what chains you to the keyboard. Kalfa asks everything it needs in a single
 * batch, once, and then never asks again. Same information, one sitting.
 *
 * Everything the interview fails to pin down does not become a later question.
 * It becomes a decision record the agent writes alone, by design.
 */

/** A read-only agent: it inspects the repository and must not modify it. */
export function plannerAgent(model?: string): AgentConfig {
  return AgentSchema.parse({
    provider: 'claude',
    ...(model ? { model } : {}),
    permission_mode: 'acceptEdits',
    // Enforced by the CLI, not by asking nicely. A planner that edits code has
    // started the work before you have agreed to it.
    disallowed_tools: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'],
    max_turns: 40,
    timeout_ms: 15 * 60 * 1000,
  });
}

export const QuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  /** Why the answer changes the plan. Shown so you can judge if it matters. */
  why: z.string().default(''),
  /** The planner's own answer if you press Enter. Never empty. */
  suggested: z.string().default(''),
});
export type Question = z.infer<typeof QuestionSchema>;

const QuestionsPayload = z.object({ questions: z.array(QuestionSchema) });

export interface Answer {
  question: string;
  answer: string;
  /** True when the user pressed Enter and took the planner's suggestion. */
  defaulted: boolean;
}

/** Shared preamble. The planner is writing FOR an agent that cannot ask. */
const PLANNER_ROLE = `You are planning work for Kalfa, an unattended build runner.

Kalfa will execute your plan with no human present. Each task is handed to a
coding agent that CANNOT ask questions: anything you leave vague becomes an
assumption that agent makes alone, at 3am, and files as an ADR. Your job
is to leave as little to assumption as possible.

Tasks run ONE AT A TIME, in dependency order, each starting from the commit the
previous task produced. After each task, configured gates (typecheck, tests)
run, and a reviewer from a different vendor reads the diff. A task that fails
its gates three times is abandoned and stashed.`;

export function interviewPrompt(goal: string, maxQuestions: number): string {
  return `${PLANNER_ROLE}

## The goal
${goal}

## Your job right now
Inspect this repository — its structure, conventions, test setup, existing
patterns — and work out what you would need to know to write a plan you would
not have to guess at.

Then ask AT MOST ${maxQuestions} questions. This is the ONLY time you may ask.
There is no follow-up round.

Ask only about things that:
- change what gets built or how it is structured, AND
- you genuinely cannot determine by reading the repository

Do NOT ask about: code style, naming, formatting, library choice where the repo
already shows a preference, or anything a conventional default settles. Those
are your call — make them.

For every question, provide a "suggested" answer: the choice you would make if
nobody replied. It must be a real, specific answer, not "it depends". Most
users will press Enter, so treat the suggestion as your actual recommendation.

Reply with ONLY this JSON, no prose:
{"questions":[{"id":"q1","question":"...","why":"what this changes about the plan","suggested":"..."}]}

If the repository and goal are clear enough that you would not benefit from
asking anything, reply {"questions":[]}. That is a good outcome, not a failure.`;
}

export function planPrompt(
  goal: string,
  answers: Answer[],
  repair?: string,
  spec?: string,
): string {
  // A spec, when one exists, is the source of truth — the goal line is only a
  // pointer into it. Non-goals in particular have to reach the planner: they
  // are what stop it inventing tasks nobody asked for.
  const specBlock = spec
    ? `\n## The specification\nThis is authoritative. Plan to it, and to nothing beyond it —\nespecially respect its non-goals.\n\n${spec}\n`
    : '';
  const context =
    answers.length > 0
      ? `\n## Answers you were given\n${answers
          .map(
            (a) =>
              `- Q: ${a.question}\n  A: ${a.answer}${a.defaulted ? ' (user accepted your suggestion)' : ''}`,
          )
          .join('\n')}\n`
      : '';

  const repairBlock = repair
    ? `\n## Your previous attempt was rejected\nThe plan you produced failed validation:\n\`\`\`\n${repair}\n\`\`\`\nFix exactly these problems. Do not restructure the rest.\n`
    : '';

  return `${PLANNER_ROLE}

## The goal
${goal}
${specBlock}${context}${repairBlock}
## Your job right now
Write the plan. Inspect the repository first if you have not already.

### What makes a good task
- **Small enough to verify.** One coherent change a reviewer can check in one
  sitting. If a task needs three unrelated things, it is three tasks.
- **Ordered by real dependency.** \`deps\` means "cannot start until that
  commit exists". Do not invent dependencies for tidiness — independent tasks
  should stay independent.
- **Self-contained \`details\`.** Written for an agent that has never seen this
  plan, cannot see other tasks, and cannot ask you anything. Name the files,
  the existing patterns to follow, the edge cases that matter. This is the
  single highest-leverage field in the plan.
- **Machine-checkable \`acceptance\`.** Prefer "returns 429 when over the
  limit" over "handles rate limiting well". Each criterion should be something
  a test could assert or a reviewer could confirm from the diff.
- **Tests belong inside the task that needs them**, not batched into a final
  "write tests" task. A task whose tests come later is a task that ships
  unverified.

### Hard rules
- The first task must be runnable against the repository as it exists today.
- Every \`deps\` entry must be an id defined in this same plan.
- No cycles.
- Prefer 3-12 tasks. If the goal genuinely needs more, split the goal instead
  and say so in the goal field.

Reply with ONLY the JSON plan, no prose, no code fence:
{"version":1,"goal":"one sentence","tasks":[{"id":"T1","title":"...","details":"...","deps":[],"files":["..."],"acceptance":["..."]}]}`;
}

/**
 * Models wrap JSON in prose or fences even when told not to. Same recovery
 * ladder as the review parser: strict, then fenced, then outermost braces.
 */
export function extractJson(text: string): unknown | undefined {
  const candidates: string[] = [text.trim()];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return undefined;
}

/** Flatten zod issues into the repair text handed back to the planner. */
export function formatValidationErrors(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${where}: ${issue.message}`;
    })
    .join('\n');
}

export interface GenerateOptions {
  goal: string;
  cwd: string;
  answers: Answer[];
  /** The SPEC.md contents, when the project has one. Authoritative if present. */
  spec?: string;
  /** Validation-repair attempts. A plan that never validates is not written. */
  maxAttempts?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: number, errors?: string) => void;
}

export interface GenerateResult {
  plan: Plan;
  costUsd: number;
  attempts: number;
}

export class PlanGenerationError extends Error {
  constructor(
    message: string,
    readonly lastOutput?: string,
  ) {
    super(message);
    this.name = 'PlanGenerationError';
  }
}

export async function askQuestions(
  planner: AgentInvoker,
  goal: string,
  cwd: string,
  maxQuestions: number,
  signal?: AbortSignal,
): Promise<{ questions: Question[]; costUsd: number }> {
  const run = await planner.invoke(interviewPrompt(goal, maxQuestions), {
    cwd,
    ...(signal ? { signal } : {}),
  });

  if (!run.ok) throw new PlanGenerationError(run.error ?? 'planner failed', run.text);

  const parsed = QuestionsPayload.safeParse(extractJson(run.text));
  if (!parsed.success) {
    // An unreadable question list is not worth a retry round-trip; falling
    // through to generation without answers is a valid, cheaper outcome.
    return { questions: [], costUsd: run.costUsd };
  }
  return { questions: parsed.data.questions.slice(0, maxQuestions), costUsd: run.costUsd };
}

export async function generatePlan(
  planner: AgentInvoker,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let repair: string | undefined;
  let costUsd = 0;
  let lastOutput = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    opts.onAttempt?.(attempt, repair);

    const run = await planner.invoke(planPrompt(opts.goal, opts.answers, repair, opts.spec), {
      cwd: opts.cwd,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    costUsd += run.costUsd;
    lastOutput = run.text;

    if (!run.ok) {
      repair = run.error ?? 'the planner process failed';
      continue;
    }

    const json = extractJson(run.text);
    if (json === undefined) {
      repair = 'Your reply contained no parseable JSON object. Reply with JSON only.';
      continue;
    }

    const parsed = PlanSchema.safeParse(json);
    if (parsed.success) return { plan: parsed.data, costUsd, attempts: attempt };

    repair = formatValidationErrors(parsed.error);
  }

  // Refusing to write an invalid plan is the point: an unattended run against
  // a broken plan fails slowly and expensively, hours from now.
  throw new PlanGenerationError(
    `planner did not produce a valid plan in ${maxAttempts} attempts. Last problems:\n${repair ?? 'unknown'}`,
    lastOutput,
  );
}
