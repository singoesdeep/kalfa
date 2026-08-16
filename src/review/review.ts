import { z } from 'zod';
import type { AgentInvoker, InvokeOptions } from '../agents/provider.js';
import type { Task } from '../plan/schema.js';
import { REVIEW_OUTPUT_SCHEMA, reviewPrompt } from '../prompts/contract.js';
import { SEVERITY_RANK, type PolicyConfig } from '../config/schema.js';
import type { ReviewClaim, ReviewFinding, ReviewResult } from '../types.js';
import { checkFindings } from './claims.js';

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

/**
 * Anything that is not exactly "file_changed" becomes "other".
 *
 * Not an enum, deliberately. A strict enum would make one unexpected string
 * fail the whole payload, and an unparseable review blocks the task — so a
 * model improvising a claim label would cost the work. Falling back to "other"
 * costs only the mechanical check on that finding, which is the safe direction.
 */
const nullableClaim = z
  .string()
  .nullish()
  .transform((v): ReviewClaim | undefined =>
    v == null ? undefined : v === 'file_changed' ? 'file_changed' : 'other',
  );

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
  claim: nullableClaim,
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

export interface ReviewOptions {
  reviewer: AgentInvoker;
  task: Task;
  cwd: string;
  gateCommands: string[];
  policy: PolicyConfig;
  signal?: AbortSignal;
  protectedCallout?: string;
  upcoming?: Array<{ id: string; title: string }>;
  /**
   * The files this diff actually touches, for checking the findings against.
   *
   * Supplied by the caller rather than read here: the runner already has it
   * (protected-path detection runs off the same list) and a review that shells
   * out to git on its own could read a tree the reviewer never saw.
   */
  changedFiles?: string[];
  /**
   * Persist a piece of the review and return the path it landed at.
   *
   * The run log can only afford a line per finding, and BLOCKED.md a
   * paragraph. Whatever the reviewer actually said — including the raw text
   * behind an "unparseable output" error, which is the one case where the
   * summary is useless — goes here, in full, at a path the summary can cite.
   */
  capture?: (kind: 'request' | 'raw' | 'findings', content: string) => string;
  /** Passed through to the invoker, so the reviewer is as visible as the builder. */
  observe?: Pick<InvokeOptions, 'onSpawn' | 'onOutput'>;
}

export async function reviewTask(opts: ReviewOptions): Promise<ReviewResult> {
  const { reviewer, task, cwd, gateCommands, policy } = opts;
  const prompt = reviewPrompt(task, gateCommands, opts.protectedCallout, opts.upcoming ?? []);

  const capture = (kind: 'request' | 'raw' | 'findings', content: string): string | undefined =>
    opts.capture?.(kind, content);

  capture(
    'request',
    JSON.stringify(
      {
        reviewer: reviewer.label,
        task: task.id,
        blockingSeverity: policy.blocking_severity,
        gateCommands,
        protectedCallout: opts.protectedCallout ?? null,
        promptChars: prompt.length,
      },
      null,
      2,
    ),
  );

  const run = await reviewer.invoke(prompt, {
    cwd,
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.observe?.onSpawn ? { onSpawn: opts.observe.onSpawn } : {}),
    ...(opts.observe?.onOutput ? { onOutput: opts.observe.onOutput } : {}),
  });

  const rawPath = run.text ? capture('raw', run.text) : undefined;
  const paths = rawPath ? { rawPath } : {};

  if (!run.ok) {
    return {
      findings: [],
      blocking: [],
      discarded: [],
      costUsd: run.costUsd,
      costKnown: run.costKnown,
      durationMs: run.durationMs,
      error: run.error ?? 'reviewer failed',
      ...paths,
    };
  }

  const findings = parseReviewPayload(run.text);
  if (!findings) {
    // An unreadable review must not silently pass the work. It is reported as
    // an error and the caller decides; it never counts as "no findings".
    return {
      findings: [],
      blocking: [],
      discarded: [],
      costUsd: run.costUsd,
      costKnown: run.costKnown,
      durationMs: run.durationMs,
      error: `reviewer returned unparseable output: ${run.text.slice(0, 500)}`,
      ...paths,
    };
  }

  // The one check on the reviewer. A finding that says the diff did something
  // the diff did not do is reported and then ignored — it never blocks, and it
  // never costs an attempt. See src/review/claims.ts for why this is narrow.
  const checked = opts.changedFiles
    ? checkFindings(findings, opts.changedFiles)
    : { all: findings, discarded: [] as ReviewFinding[], standing: findings };

  const findingsPath = capture(
    'findings',
    `${JSON.stringify({ findings: checked.all, discarded: checked.discarded }, null, 2)}\n`,
  );

  return {
    findings: checked.all,
    blocking: blockingFindings(checked.standing, policy.blocking_severity),
    discarded: checked.discarded,
    costUsd: run.costUsd,
    costKnown: run.costKnown,
    durationMs: run.durationMs,
    ...paths,
    ...(findingsPath ? { findingsPath } : {}),
  };
}
