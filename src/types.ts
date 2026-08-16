/** Shared runtime types. Config/plan shapes live with their zod schemas. */

export type TaskStatus = 'pending' | 'running' | 'done' | 'blocked' | 'skipped';

/** Why an attempt failed, fed back verbatim into the next attempt's prompt. */
export interface Feedback {
  kind: 'gate' | 'review' | 'agent';
  /** Human/agent-readable label, e.g. "typecheck" or "reviewer". */
  source: string;
  detail: string;
}

export interface AgentRun {
  /** Final assistant message. */
  text: string;
  ok: boolean;
  costUsd: number;
  /**
   * Whether costUsd is real or a placeholder.
   *
   * The codex CLI does not report per-run cost, and Kalfa will not invent one
   * from a local price table. Its runs report 0 with costKnown false, so a
   * total can be labelled as the floor it actually is rather than passed off
   * as the whole bill.
   */
  costKnown: boolean;
  durationMs: number;
  /** Provider session id, when the provider reports one. */
  sessionId?: string;
  /** Non-zero exit or transport failure, as opposed to a task-level failure. */
  error?: string;
}

export interface GateResult {
  name: string;
  ok: boolean;
  exitCode: number;
  /** Trimmed combined output — what the next attempt gets to read. */
  output: string;
  durationMs: number;
  /** True when the gate never ran because an earlier required gate failed. */
  skipped?: boolean;
}

export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor';
  summary: string;
  // Explicitly `| undefined`: these arrive from a parsed JSON payload where an
  // absent key and a present-but-undefined key are the same thing.
  file?: string | undefined;
  line?: number | undefined;
  suggestion?: string | undefined;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  /** Findings at or above the configured blocking severity. */
  blocking: ReviewFinding[];
  costUsd: number;
  /** False when the provider does not report cost — see AgentRun.costKnown. */
  costKnown: boolean;
  durationMs: number;
  /** Set when the reviewer itself failed to run or returned unparseable output. */
  error?: string;
}

export interface AttemptRecord {
  attempt: number;
  agentCostUsd: number;
  reviewCostUsd: number;
  durationMs: number;
  gates: GateResult[];
  reviewFindings: number;
  blockingFindings: number;
  outcome: 'passed' | 'gate_failed' | 'review_failed' | 'agent_failed';
}

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  attempts: AttemptRecord[];
  commit?: string;
  /** Set when status is 'blocked' or 'skipped'. */
  reason?: string;
  /** Stash ref holding the abandoned work, when a blocked task was stashed. */
  stashRef?: string;
  /** Test or check files this task modified. Surfaced for human review. */
  protectedPaths?: string[];
  /**
   * Decision records this task produced.
   *
   * Kalfa cannot tell whether a task *should* have recorded a decision. It can
   * count, and a run that resolved a dozen tasks without writing one is worth
   * noticing: either the spec left nothing to assume, or assumptions were made
   * silently. Both readings matter, and only the reader can tell them apart.
   */
  adrsWritten?: number;
  costUsd: number;
  durationMs: number;
}

export interface RunRecord {
  runId: string;
  /** True when some agent could not report its cost, so totals are a floor. */
  costIncomplete?: boolean;
  startedAt: string;
  finishedAt?: string;
  planPath: string;
  branch?: string;
  baseCommit?: string;
  tasks: Record<string, TaskRecord>;
}
