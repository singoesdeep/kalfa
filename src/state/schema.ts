import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { RunRecord } from '../types.js';

/**
 * The on-disk contract for `.kalfa/state.json`.
 *
 * Run state is the one file Kalfa reads back after an upgrade. An interrupted
 * run is resumed by a CLI that may be newer than the one that wrote it, and
 * the failure mode of guessing is expensive rather than noisy: tasks already
 * paid for get run again, or a blocked task's stash ref and provenance are
 * quietly dropped. Config and plan files have been validated at the boundary
 * since the beginning; this gives run state the same treatment, plus the
 * version stamp and ordered migrations that a resumable file needs.
 */
export const STATE_SCHEMA_VERSION = 1;

/** What went wrong, for callers that phrase their own advice. */
export type StateProblem =
  /** The file is not JSON at all. */
  | 'unreadable'
  /** Valid JSON, wrong shape for any version Kalfa knows. */
  | 'invalid'
  /** Written by a newer Kalfa than the one reading it. */
  | 'too_new';

export class StateError extends Error {
  constructor(
    message: string,
    readonly problem: StateProblem,
    readonly path: string,
  ) {
    super(message);
    this.name = 'StateError';
  }
}

const GateResultSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    exitCode: z.number().default(0),
    output: z.string().default(''),
    durationMs: z.number().default(0),
  })
  // Passthrough everywhere, deliberately. Stripping is zod's default and it
  // would silently delete fields a newer patch release added, on the first
  // write after the read. Old evidence outlives the code that wrote it.
  .passthrough();

const AttemptSchema = z
  .object({
    attempt: z.number(),
    agentCostUsd: z.number().default(0),
    reviewCostUsd: z.number().default(0),
    durationMs: z.number().default(0),
    gates: z.array(GateResultSchema).default([]),
    reviewFindings: z.number().default(0),
    blockingFindings: z.number().default(0),
    outcome: z.enum(['passed', 'gate_failed', 'review_failed', 'agent_failed']),
    artifactsDir: z.string().optional(),
  })
  .passthrough();

const TaskRecordSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['pending', 'running', 'done', 'blocked', 'skipped']),
    attempts: z.array(AttemptSchema).default([]),
    commit: z.string().optional(),
    reason: z.string().optional(),
    stashRef: z.string().optional(),
    protectedPaths: z.array(z.string()).optional(),
    adrsWritten: z.number().optional(),
    costUsd: z.number().default(0),
    durationMs: z.number().default(0),
  })
  .passthrough();

export const RunRecordSchema = z
  .object({
    schemaVersion: z.literal(STATE_SCHEMA_VERSION),
    runId: z.string().min(1),
    costIncomplete: z.boolean().optional(),
    startedAt: z.string().min(1),
    finishedAt: z.string().optional(),
    planPath: z.string(),
    branch: z.string().optional(),
    baseCommit: z.string().optional(),
    runDir: z.string().optional(),
    stoppedEarly: z.string().optional(),
    tasks: z.record(z.string(), TaskRecordSchema).default({}),
  })
  .passthrough();

interface Migration {
  from: number;
  to: number;
  /** Pure: takes a record of the `from` shape, returns one of the `to` shape. */
  migrate: (state: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Ordered and contiguous: v0 -> v1 -> v2 -> ... Each step is applied in turn,
 * so a state file from any released version reaches the current shape by
 * replaying the same steps every other reader replays.
 */
const MIGRATIONS: Migration[] = [
  {
    from: 0,
    to: 1,
    /**
     * Kalfa 0.1.0 wrote no version stamp. Its shape is exactly v1's, so this
     * only stamps the record — nothing is rewritten, renamed or dropped, which
     * is what lets a 0.1.0 run resume without repeating a task it finished.
     */
    migrate: (state) => ({ ...state, schemaVersion: 1 }),
  },
];

export interface LoadedState {
  record: RunRecord;
  /** The version as found on disk, before migration. 0 means unstamped. */
  diskVersion: number;
  /** True when the record had to be migrated to be readable by this build. */
  migrated: boolean;
}

/** Turn a zod error into something readable without a stack trace. */
function formatIssues(error: z.ZodError, path: string): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  ${where}: ${issue.message}`;
  });
  return `${path} is not valid run state:\n${lines.join('\n')}`;
}

/**
 * The version stamp on a parsed state document.
 *
 * An absent stamp is version 0 — the unversioned shape Kalfa 0.1.0 wrote —
 * rather than an error, because those files exist in real repositories with
 * real interrupted runs in them.
 */
function stateVersion(state: Record<string, unknown>, path: string): number {
  const raw = state['schemaVersion'];
  if (raw === undefined) return 0;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new StateError(
      `${path} has an unreadable schemaVersion (${JSON.stringify(raw)}) — expected a whole number`,
      'invalid',
      path,
    );
  }
  return raw;
}

/**
 * Validate and, if needed, migrate a parsed state document.
 *
 * Pure: the caller decides whether a migrated record is worth writing back.
 * Throws rather than falling back to an empty run — a resume that silently
 * starts from nothing is the expensive failure this whole module exists to
 * prevent.
 */
export function parseState(raw: unknown, path: string): LoadedState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StateError(`${path} is not a run state object`, 'invalid', path);
  }

  let state = raw as Record<string, unknown>;
  const diskVersion = stateVersion(state, path);

  if (diskVersion > STATE_SCHEMA_VERSION) {
    throw new StateError(
      `${path} was written by a newer kalfa (state schema v${diskVersion}; this build reads v${STATE_SCHEMA_VERSION})`,
      'too_new',
      path,
    );
  }

  let version = diskVersion;
  for (const migration of MIGRATIONS) {
    if (migration.from < version) continue;
    state = migration.migrate(state);
    version = migration.to;
  }

  const parsed = RunRecordSchema.safeParse(state);
  if (!parsed.success) throw new StateError(formatIssues(parsed.error, path), 'invalid', path);

  return {
    record: parsed.data as RunRecord,
    diskVersion,
    migrated: diskVersion !== STATE_SCHEMA_VERSION,
  };
}

/**
 * Read `state.json`, or undefined when there is none.
 *
 * Absent state is a fact ("nothing has run here"); malformed state is a
 * problem, and the difference matters enough to be carried in the type.
 */
export function readStateFile(path: string): LoadedState | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new StateError(
      `${path} is not valid JSON: ${(err as Error).message}`,
      'unreadable',
      path,
    );
  }
  return parseState(raw, path);
}

/** What the operator should do about a broken or unreadable state file. */
export function remedyFor(problem: StateProblem): string {
  switch (problem) {
    case 'too_new':
      return 'upgrade kalfa to the version that wrote this run, or start a fresh run in a clean checkout';
    case 'unreadable':
      return 'the file was likely truncated by a crash — move it aside and start a new run with `kalfa run --new`';
    case 'invalid':
      return 'move `.kalfa/state.json` aside and start a new run with `kalfa run --new` — kalfa will not guess at what the run had already done';
  }
}
