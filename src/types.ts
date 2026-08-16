/** Shared runtime types. Config/plan shapes live with their zod schemas. */

export type TaskStatus = 'pending' | 'running' | 'done' | 'blocked' | 'skipped';

/**
 * What the run is doing right now.
 *
 * A live run used to be legible only in retrospect: `builder ok`, `gate pass`,
 * `review 2 blocking`, and between those lines minutes of silence in which the
 * operator could not tell working from stalled. Naming the phase is what makes
 * "which process is running, on what" answerable at any instant.
 */
export type Phase =
  | 'preparing'
  | 'builder'
  | 'collecting_diff'
  | 'gate'
  | 'review'
  | 'second_opinion'
  | 'retry'
  | 'commit'
  | 'stash'
  | 'blocked';

export const PHASE_LABEL: Record<Phase, string> = {
  preparing: 'preparing prompt',
  builder: 'builder running',
  collecting_diff: 'collecting diff',
  gate: 'running gate',
  review: 'reviewer running',
  second_opinion: 'reviewer running (second opinion)',
  retry: 'persisting retry',
  commit: 'committing',
  stash: 'stashing abandoned work',
  blocked: 'writing block report',
};

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
  /** The command line Kalfa actually spawned, for the operator to reproduce. */
  commandLine?: string;
  /** OS process id, so a live run can be inspected with the usual tools. */
  pid?: number;
  /** Repo-relative artifact paths holding the untruncated transcript. */
  stdoutPath?: string;
  stderrPath?: string;
  /** Tool/command activity, when the vendor CLI reports any. */
  toolEventsPath?: string;
  /**
   * False when the provider gives no tool-level visibility at all.
   *
   * Recorded rather than glossed over: an operator watching a codex reviewer
   * sit silent for four minutes deserves to know that the silence is the CLI's
   * limitation and not a hang.
   */
  toolEventsSupported: boolean;
  /** Wall-clock of the last byte the child produced — a liveness heartbeat. */
  lastOutputAt?: string;
}

/** One tool call or shell command a builder made, as far as the CLI reports it. */
export interface ToolEvent {
  at: string;
  /** 'Bash', 'Edit', 'Read', ... — the vendor's own tool name. */
  name: string;
  /** A one-line rendering of the arguments: the command, the file path. */
  detail?: string;
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
  /** The exact shell command, so the operator can run it themselves. */
  command?: string;
  /** Repo-relative artifact paths holding the full, untrimmed streams. */
  stdoutPath?: string;
  stderrPath?: string;
  /** True when `output` above is a tail of something longer. */
  truncated?: boolean;
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
  /** Repo-relative path to the reviewer's untruncated response. */
  rawPath?: string;
  /** Repo-relative path to the parsed findings, every severity included. */
  findingsPath?: string;
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
  /**
   * Where this attempt's complete evidence lives, repo-relative.
   *
   * Recorded on the attempt rather than derived by the reader, so a retry
   * cause in the log, a line in BLOCKED.md and a state file entry all cite the
   * same directory instead of three descriptions of it.
   */
  artifactsDir?: string;
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
  /**
   * The shape this record was written in — see src/state/schema.ts.
   *
   * Present so a later CLI can tell an old run it can migrate from one it must
   * refuse. State written before versioning existed is treated as v0 and
   * stamped on first read.
   */
  schemaVersion: number;
  runId: string;
  /** True when some agent could not report its cost, so totals are a floor. */
  costIncomplete?: boolean;
  startedAt: string;
  finishedAt?: string;
  planPath: string;
  branch?: string;
  baseCommit?: string;
  /** Repo-relative run directory holding this run's artifacts. */
  runDir?: string;
  /** Set when the run stopped before finishing the plan, with the reason. */
  stoppedEarly?: string;
  tasks: Record<string, TaskRecord>;
}
