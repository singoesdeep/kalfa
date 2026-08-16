import { z } from 'zod';
import type { AgentInvoker } from '../agents/provider.js';
import type { Task } from '../plan/schema.js';
import { REVIEW_OUTPUT_SCHEMA, reviewPrompt } from '../prompts/contract.js';
import { SEVERITY_RANK, type PolicyConfig } from '../config/schema.js';
import type { ReviewFinding, ReviewResult } from '../types.js';

/**
 * The cross-model review gate.
 *
 * This is where "quality" actually comes from. The builder cannot be trusted
 * to grade its own homework — not because it lies, but because whatever
 * misunderstanding produced the bug also produces the self-assessment. A
 * different vendor's model reading only the diff does not share that
 * misunderstanding.
 */

/**
 * Optional fields arrive as explicit nulls, because the output schema has to
 * list every key as required (see REVIEW_OUTPUT_SCHEMA). Normalize null to
 * absent here so the rest of the code never has to think about it.
 */
const nullableString = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

const FindingSchema = z.object({
  severity: z.enum(['blocker', 'major', 'minor']),
  summary: z.string(),
  file: nullableString,
  line: z
    .number()
    .int()
    .nullish()
    .transform((v) => v ?? undefined),
  suggestion: nullableString,
});

const ReviewPayloadSchema = z.object({ findings: z.array(FindingSchema) });

/**
 * Models wrap JSON in prose or fences even when handed a schema. Try strict
 * parse, then a fenced block, then the outermost brace pair.
 */
export function parseReviewPayload(text: string): ReviewFinding[] | undefined {
  const candidates: string[] = [text.trim()];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = ReviewPayloadSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data.findings;
    } catch {
      // Try the next shape.
    }
  }
  return undefined;
}

export function blockingFindings(
  findings: ReviewFinding[],
  threshold: PolicyConfig['blocking_severity'],
): ReviewFinding[] {
  const min = SEVERITY_RANK[threshold];
  return findings.filter((f) => SEVERITY_RANK[f.severity] >= min);
}

/** Render findings for the retry prompt, worst first. */
export function formatFindings(findings: ReviewFinding[]): string {
  const order = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return order
    .map((f) => {
      const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
      const fix = f.suggestion ? `\n  suggested fix: ${f.suggestion}` : '';
      return `[${f.severity}]${where} ${f.summary}${fix}`;
    })
    .join('\n\n');
}

export async function reviewTask(
  reviewer: AgentInvoker,
  task: Task,
  cwd: string,
  gateCommands: string[],
  policy: PolicyConfig,
  signal?: AbortSignal,
  protectedCallout?: string,
): Promise<ReviewResult> {
  const run = await reviewer.invoke(reviewPrompt(task, gateCommands, protectedCallout), {
    cwd,
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    ...(signal ? { signal } : {}),
  });

  if (!run.ok) {
    return {
      findings: [],
      blocking: [],
      costUsd: run.costUsd,
      costKnown: run.costKnown,
      durationMs: run.durationMs,
      error: run.error ?? 'reviewer failed',
    };
  }

  const findings = parseReviewPayload(run.text);
  if (!findings) {
    // An unreadable review must not silently pass the work. It is reported as
    // an error and the caller decides; it never counts as "no findings".
    return {
      findings: [],
      blocking: [],
      costUsd: run.costUsd,
      costKnown: run.costKnown,
      durationMs: run.durationMs,
      error: `reviewer returned unparseable output: ${run.text.slice(0, 500)}`,
    };
  }

  return {
    findings,
    blocking: blockingFindings(findings, policy.blocking_severity),
    costUsd: run.costUsd,
    costKnown: run.costKnown,
    durationMs: run.durationMs,
  };
}
