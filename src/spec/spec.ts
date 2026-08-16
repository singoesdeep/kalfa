import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentInvoker } from '../agents/provider.js';
import { extractJson, PlanGenerationError, type Answer } from '../plan/generate.js';

/**
 * PRD and SPEC.
 *
 * A one-line goal string is a thin contract to hand an agent that will work
 * unsupervised for hours. Two documents carry what it cannot infer:
 *
 *   PRD  — why this is being built, for whom, and what "working" means.
 *          Read by the planner. Rarely read by individual tasks.
 *   SPEC — what exactly gets built: behaviour, contracts, and NON-GOALS.
 *          Read by the planner and available to every task.
 *
 * Non-goals earn their place on their own. The characteristic failure of an
 * unattended agent is not doing too little, it is doing too much — adding
 * caching nobody asked for, generalising a function used once. A written list
 * of what is out of scope is the only thing the reviewer can hold a diff
 * against when it looks for scope creep.
 */

export const DOCS_DIR = 'docs';
export const PRD_PATH = join(DOCS_DIR, 'PRD.md');
export const SPEC_PATH = join(DOCS_DIR, 'SPEC.md');

const SpecPayload = z.object({
  prd: z.string().min(50, 'PRD is too short to be useful'),
  spec: z.string().min(50, 'SPEC is too short to be useful'),
});

export interface SpecDocuments {
  prd: string;
  spec: string;
}

export function specPrompt(goal: string, answers: Answer[], repair?: string): string {
  const context =
    answers.length > 0
      ? `\n## Answers you were given\n${answers
          .map((a) => `- Q: ${a.question}\n  A: ${a.answer}${a.defaulted ? ' (accepted your suggestion)' : ''}`)
          .join('\n')}\n`
      : '';

  const repairBlock = repair
    ? `\n## Your previous attempt was rejected\n\`\`\`\n${repair}\n\`\`\`\nFix exactly these problems.\n`
    : '';

  return `You are writing the product and technical specification for work that will
be executed by autonomous agents with no human present.

## The goal
${goal}
${context}${repairBlock}
## Your job
Inspect this repository first — its purpose, stack, conventions, existing
features. Then write two documents.

### PRD.md — why
- **Problem**: what is broken or missing today, concretely
- **Users**: who is affected and what they are trying to do
- **Success criteria**: how anyone would know this worked. Observable, not
  aspirational. "p95 webhook latency under 200ms", not "better performance"
- **Out of scope**: what this explicitly does not address
Keep it short. A PRD nobody reads is worse than no PRD.

### SPEC.md — what
- **Overview**: one paragraph
- **Behaviour**: what the system does, case by case, including error cases and
  edge cases. This is the bulk of the document
- **Interfaces and contracts**: function signatures, endpoints, schemas, config
  keys, or file formats that this work introduces or changes. Name them exactly
- **Data and state**: what is stored, where, and what happens on migration
- **Non-goals**: what an implementer might reasonably assume is included and is
  NOT. Be specific and slightly paranoid here
- **Open questions**: anything genuinely undecided, each with the default that
  will be taken if nobody decides

### The audience is not human
Every task built from this will be handed to an agent that cannot ask you
anything. Ambiguity you leave here becomes an assumption it makes alone. State
things that feel obvious — obvious to you is not present in its context.

Do not write implementation steps, task lists, or sequencing. That is the
plan's job, and it is generated separately from this.

Reply with ONLY this JSON, no prose, no code fence. Both values are markdown
documents as strings:
{"prd":"# Product Requirements\\n\\n...","spec":"# Specification\\n\\n..."}`;
}

/** Structural checks only. Nothing here judges whether the content is right. */
export function validateSpec(docs: SpecDocuments): string[] {
  const problems: string[] = [];
  const spec = docs.spec.toLowerCase();

  if (!/non-?goals?/.test(spec)) {
    problems.push(
      'SPEC.md has no "Non-goals" section. It is required: it is the only thing ' +
        'the reviewer can hold a diff against when checking for scope creep.',
    );
  }
  if (!/behaviou?r|## /.test(spec)) {
    problems.push('SPEC.md has no section headings — it must be a structured document.');
  }
  if (!/success criteria/i.test(docs.prd)) {
    problems.push('PRD.md has no "Success criteria" section.');
  }
  return problems;
}

export interface GenerateSpecOptions {
  goal: string;
  cwd: string;
  answers: Answer[];
  maxAttempts?: number;
  signal?: AbortSignal;
  onAttempt?: (attempt: number, problems?: string) => void;
}

export async function generateSpec(
  planner: AgentInvoker,
  opts: GenerateSpecOptions,
): Promise<{ docs: SpecDocuments; costUsd: number; attempts: number }> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let repair: string | undefined;
  let costUsd = 0;
  let lastOutput = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    opts.onAttempt?.(attempt, repair);

    const run = await planner.invoke(specPrompt(opts.goal, opts.answers, repair), {
      cwd: opts.cwd,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    costUsd += run.costUsd;
    lastOutput = run.text;

    if (!run.ok) {
      repair = run.error ?? 'the planner process failed';
      continue;
    }

    const parsed = SpecPayload.safeParse(extractJson(run.text));
    if (!parsed.success) {
      repair = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      continue;
    }

    const problems = validateSpec(parsed.data);
    if (problems.length === 0) return { docs: parsed.data, costUsd, attempts: attempt };
    repair = problems.join('\n');
  }

  throw new PlanGenerationError(
    `the spec did not pass validation in ${maxAttempts} attempts:\n${repair ?? 'unknown'}`,
    lastOutput,
  );
}

export function writeSpec(cwd: string, docs: SpecDocuments): { prd: string; spec: string } {
  mkdirSync(join(cwd, DOCS_DIR), { recursive: true });
  const prd = join(cwd, PRD_PATH);
  const spec = join(cwd, SPEC_PATH);
  writeFileSync(prd, docs.prd.endsWith('\n') ? docs.prd : `${docs.prd}\n`, 'utf8');
  writeFileSync(spec, docs.spec.endsWith('\n') ? docs.spec : `${docs.spec}\n`, 'utf8');
  return { prd: PRD_PATH, spec: SPEC_PATH };
}

/**
 * The spec as the planner's source of truth.
 *
 * When it exists it replaces the one-line goal, which is why `kalfa plan` can
 * be called with no argument once a spec is written.
 */
export function readSpec(cwd: string): string | undefined {
  const path = join(cwd, SPEC_PATH);
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}
