import type { KalfaConfig } from '../config/schema.js';
import type { Plan, Task } from '../plan/schema.js';
import { topoOrder } from '../plan/schema.js';
import { AgentInvoker } from '../agents/provider.js';
import {
  blockingFailures,
  gatesForTask,
  runGates,
  type GateObserver,
  type GateSinks,
} from '../gates/gates.js';
import { protectedAmong, protectedPathsCallout } from '../gates/protected.js';
import { formatFindings, reviewTask } from '../review/review.js';
import { formatDiscarded } from '../review/claims.js';
import {
  AUTONOMY_CONTRACT,
  retryPrompt,
  taskPrompt,
  type PriorAttempt,
} from '../prompts/contract.js';
import { Journal } from '../journal/journal.js';
import { StateStore } from '../state/store.js';
import type { ArtifactStore } from '../state/artifacts.js';
import { writeBoard } from '../board/board.js';
import { adrInstructions, nextAdrNumber, readAdrs, refreshAdrIndex } from '../adr/adr.js';
import * as git from '../git/git.js';
import type {
  AgentRun,
  AttemptRecord,
  Feedback,
  GateResult,
  Phase,
  ReviewFinding,
  ReviewResult,
  TaskStatus,
  ToolEvent,
} from '../types.js';

export interface RunnerOptions {
  cwd: string;
  config: KalfaConfig;
  plan: Plan;
  planPath: string;
  runId: string;
  store: StateStore;
  journal: Journal;
  signal?: AbortSignal;
  /**
   * Where per-attempt evidence is written. Omitted — as tests do — the runner
   * still runs and simply cites nothing.
   */
  artifacts?: ArtifactStore;
  /** Progress reporting. The CLI renders these; tests ignore them. */
  onEvent?: (event: RunnerEvent) => void;
  /** Injection seam for tests. Defaults to the real subprocess invoker. */
  makeInvoker?: (role: 'builder' | 'reviewer') => AgentInvoker;
}

/**
 * Everything a live observer is entitled to know.
 *
 * These are emitted as they happen, not summarised at the end, and each one
 * that names a process names the command too. The same stream reaches the
 * terminal, `.kalfa/journal.jsonl`, and through it `kalfa status --watch`.
 */
export type RunnerEvent =
  | { type: 'run_start'; total: number; branch?: string; runDir?: string }
  | { type: 'task_start'; task: Task; index: number; total: number }
  | { type: 'attempt_start'; taskId: string; attempt: number; max: number; artifactsDir?: string }
  /** The active stage of the current attempt. */
  | { type: 'phase'; taskId: string; attempt: number; phase: Phase; detail?: string }
  /** A child process was spawned: which, as what, with what pid. */
  | {
      type: 'command_start';
      taskId: string;
      attempt: number;
      phase: Phase;
      name: string;
      command: string;
      pid?: number;
      stdoutPath?: string;
      stderrPath?: string;
    }
  | {
      type: 'command_end';
      taskId: string;
      attempt: number;
      phase: Phase;
      name: string;
      exitCode?: number;
      ok: boolean;
      durationMs: number;
      stdoutPath?: string;
      stderrPath?: string;
    }
  /** One tool call the builder made, when its CLI reports them. */
  | { type: 'tool_event'; taskId: string; attempt: number; tool: ToolEvent }
  /** Live subprocess output, only emitted under --verbose. */
  | {
      type: 'output';
      taskId: string;
      attempt: number;
      phase: Phase;
      name: string;
      stream: 'stdout' | 'stderr';
      chunk: string;
    }
  | {
      type: 'agent_done';
      taskId: string;
      attempt: number;
      ok: boolean;
      costUsd: number;
      durationMs: number;
      toolCalls: number;
      toolEventsSupported: boolean;
      stdoutPath?: string;
      error?: string;
    }
  | { type: 'gates_done'; taskId: string; attempt: number; results: GateResult[] }
  | {
      type: 'review_done';
      taskId: string;
      attempt: number;
      findings: number;
      blocking: number;
      error?: string;
      findingsPath?: string;
      rawPath?: string;
      details?: ReviewFinding[];
    }
  | { type: 'second_opinion'; taskId: string; attempt: number }
  /** Something went wrong that the attempt survived — see AgentRun.note. */
  | { type: 'agent_note'; taskId: string; attempt: number; name: string; note: string }
  /** Findings git refuted, so they never reached the blocking decision. */
  | {
      type: 'claims_discarded';
      taskId: string;
      attempt: number;
      second: boolean;
      findings: ReviewFinding[];
    }
  | { type: 'protected_touched'; taskId: string; files: string[] }
  | { type: 'worker_committed'; taskId: string }
  /** Why the next attempt is happening, and where the evidence for it is. */
  | {
      type: 'retrying';
      taskId: string;
      attempt: number;
      reason: string;
      causedBy?: string;
      artifactsDir?: string;
      evidence?: string[];
    }
  | {
      type: 'task_done';
      taskId: string;
      status: TaskStatus;
      commit?: string;
      reason?: string;
      artifactsDir?: string;
    }
  | { type: 'run_end'; counts: Record<TaskStatus, number>; costUsd: number };

export interface RunSummary {
  counts: Record<TaskStatus, number>;
  costUsd: number;
  branch?: string;
  baseCommit?: string;
  stoppedEarly?: string;
}

/**
 * The unattended loop.
 *
 *   for each task in topological order:
 *     for attempt in 1..max_attempts:
 *       builder writes  ->  gates run  ->  reviewer reads the diff
 *       all green? commit and move on
 *       otherwise feed the failure back verbatim and try again
 *     attempts exhausted -> stash the work, log it, keep going
 *
 * Every branch of this loop ends in "keep going". Stopping the run is
 * reserved for conditions where continuing would be destructive or pointless:
 * a dependency that never landed, a cost ceiling, repeated blocks.
 */
export class Runner {
  private readonly builder: AgentInvoker;
  private readonly reviewer?: AgentInvoker;
  /** Carried out of the attempt loop so a blocked task can explain itself. */
  private lastFeedback: Feedback[] = [];
  private lastReport = '';
  private lastGateResults: GateResult[] = [];
  private lastStashRef: string | undefined;
  /** The final attempt's artifact directory, cited by the block report. */
  private lastArtifactsDir: string | undefined;
  private lastEvidence: string[] = [];
  /** The attempt before the current one, so a retry can cite what caused it. */
  private previousEvidence: string[] = [];
  /** Sinks handed to the running gate, so its start event can name their paths. */
  private readonly gateSinks = new Map<string, GateSinks>();

  constructor(private readonly opts: RunnerOptions) {
    const make =
      opts.makeInvoker ??
      ((role: 'builder' | 'reviewer') => {
        const agent = role === 'builder' ? opts.config.agents.builder : opts.config.agents.reviewer;
        if (!agent) throw new Error(`agent "${role}" is not configured`);
        return new AgentInvoker(agent);
      });

    this.builder = make('builder');
    if (opts.config.policy.review && opts.config.agents.reviewer) this.reviewer = make('reviewer');
  }

  private emit(event: RunnerEvent): void {
    this.opts.onEvent?.(event);
  }

  /**
   * Announce the active stage.
   *
   * Emitted and journalled together on purpose: a phase that reached the
   * terminal but not the event log would be invisible to `status --watch`, and
   * one that reached only the log would leave a live terminal silent. They are
   * the same fact and there is no reason for them to diverge.
   */
  private phase(taskId: string, attempt: number, phase: Phase, detail?: string): void {
    this.emit({ type: 'phase', taskId, attempt, phase, ...(detail ? { detail } : {}) });
    this.opts.journal.event('phase', { taskId, attempt, phase, detail });
  }

  private commandStart(event: Extract<RunnerEvent, { type: 'command_start' }>): void {
    this.emit(event);
    const { type: _type, ...fields } = event;
    this.opts.journal.event('command_started', fields);
  }

  private commandEnd(event: Extract<RunnerEvent, { type: 'command_end' }>): void {
    this.emit(event);
    const { type: _type, ...fields } = event;
    this.opts.journal.event('command_finished', fields);
  }

  /** Repo-relative artifact directory for an attempt, or undefined if disabled. */
  private artifactsDir(taskId: string, attempt: number): string | undefined {
    const store = this.opts.artifacts;
    return store ? store.rel(store.attemptDir(taskId, attempt)) : undefined;
  }

  /**
   * Watch the gates: the command before it runs, both streams as they arrive,
   * the exit code and where the full output landed.
   *
   * "gate project-check FAIL" with the output summarised into the terminal and
   * the rest in a JSON blob was the shape of the problem. A named command and
   * two file paths make the same line actionable.
   */
  private gateObserver(taskId: string, attempt: number): GateObserver {
    const artifacts = this.opts.artifacts;
    const started = new Map<string, number>();

    return {
      onStart: (gate) => {
        started.set(gate.name, Date.now());
        const sinks = this.gateSinks.get(gate.name);
        this.commandStart({
          type: 'command_start',
          taskId,
          attempt,
          phase: 'gate',
          name: gate.name,
          command: gate.run,
          ...(sinks ? { stdoutPath: sinks.stdout.path, stderrPath: sinks.stderr.path } : {}),
        });
      },
      onOutput: (gate, stream, chunk) => {
        this.emit({
          type: 'output',
          taskId,
          attempt,
          phase: 'gate',
          name: gate.name,
          stream,
          chunk,
        });
      },
      sinks: (gate) => {
        if (!artifacts) return undefined;
        const sinks = {
          stdout: artifacts.sink(taskId, attempt, `gates/${gate.name}.stdout.log`),
          stderr: artifacts.sink(taskId, attempt, `gates/${gate.name}.stderr.log`),
        };
        this.gateSinks.set(gate.name, sinks);
        return sinks;
      },
      onFinish: (result) => {
        this.commandEnd({
          type: 'command_end',
          taskId,
          attempt,
          phase: 'gate',
          name: result.name,
          exitCode: result.exitCode,
          ok: result.ok,
          durationMs: Date.now() - (started.get(result.name) ?? Date.now()),
          ...(result.stdoutPath ? { stdoutPath: result.stdoutPath } : {}),
          ...(result.stderrPath ? { stderrPath: result.stderrPath } : {}),
        });
      },
    };
  }

  /**
   * What this attempt concluded and what happens next, beside the evidence.
   *
   * The missing link in a retry chain: the log said `retry 2/3` and a
   * shortened cause, and nothing on disk connected that decision to the gate
   * output or the review that produced it. `decision.json` lists both, in the
   * attempt directory the retry line cites.
   */
  private recordDecision(
    taskId: string,
    attempt: number,
    decision: {
      outcome: AttemptRecord['outcome'];
      next: 'retry' | 'block' | 'commit';
      reason?: string;
      blocking?: ReviewFinding[];
      gates?: unknown[];
      evidence: string[];
    },
  ): void {
    this.opts.artifacts?.writeJson(taskId, attempt, 'decision.json', {
      taskId,
      attempt,
      at: new Date().toISOString(),
      ...decision,
      // Deduplicated: a gate that both streams to disk and appears in the
      // evidence list would otherwise be cited twice.
      evidence: [...new Set(decision.evidence)],
    });
  }

  /**
   * Run the reviewer, keeping its complete response on disk.
   *
   * The run log can show one line per finding and BLOCKED.md a paragraph;
   * neither is the reviewer's actual answer. Both artifacts here have earned
   * their place from real runs: `review.findings.json` because a shortened
   * blocker is unfalsifiable, and `review.raw.txt` because the one case where
   * the summary is worthless — "reviewer returned unparseable output" — is
   * exactly the case where you need to see what it really said.
   */
  private async invokeReview(opts: {
    task: Task;
    attempt: number;
    gateCommands: string[];
    callout?: string | undefined;
    evidence: string[];
    /** What the diff actually touches, for checking findings against. */
    changedFiles: string[];
    second?: boolean;
  }): Promise<ReviewResult> {
    const { task, attempt, gateCommands, callout, evidence, changedFiles } = opts;
    const second = opts.second ?? false;
    const reviewer = this.reviewer!;
    const prefix = second ? 'review.second' : 'review';
    const started = Date.now();

    /**
     * The reviewer's streams, persisted as they arrive — the same treatment
     * the builder already got.
     *
     * The asymmetry was not harmless. When a reviewer hung, its artifact
     * directory held the request and nothing else, so "is it working or is it
     * stuck?" had no answer anywhere in the repository. Diagnosing one meant
     * reading the vendor's own session logs, outside Kalfa entirely.
     */
    const stdout = this.opts.artifacts?.sink(task.id, attempt, `${prefix}.stdout.log`);
    const stderr = this.opts.artifacts?.sink(task.id, attempt, `${prefix}.stderr.log`);

    const result = await reviewTask({
      reviewer,
      task,
      cwd: this.opts.cwd,
      gateCommands,
      policy: this.opts.config.policy,
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      ...(callout ? { protectedCallout: callout } : {}),
      ...(this.opts.config.policy.verify_review_claims ? { changedFiles } : {}),
      upcoming: this.remainingAfter(task),
      ...(this.opts.artifacts
        ? {
            capture: (kind, content): string => {
              const name =
                kind === 'raw'
                  ? `${prefix}.raw.txt`
                  : kind === 'findings'
                    ? `${prefix}.findings.json`
                    : `${prefix}.request.json`;
              const ref = this.opts.artifacts!.write(task.id, attempt, name, content);
              evidence.push(ref.path);
              return ref.path;
            },
          }
        : {}),
      observe: {
        onSpawn: ({ commandLine, pid }) => {
          this.commandStart({
            type: 'command_start',
            taskId: task.id,
            attempt,
            phase: second ? 'second_opinion' : 'review',
            name: reviewer.label,
            command: commandLine,
            ...(pid !== undefined ? { pid } : {}),
            ...(stdout ? { stdoutPath: stdout.path } : {}),
            ...(stderr ? { stderrPath: stderr.path } : {}),
          });
        },
        onOutput: (stream, chunk) => {
          (stream === 'stdout' ? stdout : stderr)?.write(chunk);
        },
      },
    });

    // Sinks create their file on first write, as the builder's do, so a
    // silent reviewer still leaves none — but a stuck one now leaves whatever
    // it managed to say.
    for (const ref of [stdout?.close(), stderr?.close()]) {
      if (ref) evidence.push(ref.path);
    }

    this.commandEnd({
      type: 'command_end',
      taskId: task.id,
      attempt,
      phase: second ? 'second_opinion' : 'review',
      name: reviewer.label,
      ok: !result.error,
      durationMs: Date.now() - started,
      ...(stdout ? { stdoutPath: stdout.path } : {}),
      ...(stderr ? { stderrPath: stderr.path } : {}),
    });

    // A review that only arrived because Kalfa went and took it must say so.
    if (result.note) {
      this.emit({ type: 'agent_note', taskId: task.id, attempt, name: reviewer.label, note: result.note });
      this.opts.journal.event('agent_note', {
        taskId: task.id,
        attempt,
        phase: (second ? 'second_opinion' : 'review') satisfies Phase,
        name: reviewer.label,
        note: result.note,
      });
    }

    // Announced whatever the task goes on to do. The case that most needs
    // saying is the quiet one: a task that passes because the only blocker
    // against it was a claim about a file the diff never touched.
    if (result.discarded.length > 0) {
      this.emit({
        type: 'claims_discarded',
        taskId: task.id,
        attempt,
        second,
        findings: result.discarded,
      });
      this.opts.journal.event('review_claims_discarded', {
        taskId: task.id,
        attempt,
        phase: (second ? 'second_opinion' : 'review') satisfies Phase,
        findings: result.discarded,
      });
      const record = this.opts.store.task(task.id);
      this.opts.store.setStatus(task.id, record.status, {
        discardedFindings: [...(record.discardedFindings ?? []), ...formatDiscarded(result.discarded)],
      });
      this.refreshBoard();
    }
    return result;
  }

  /**
   * The diff as the reviewer will see it, kept beside the finding it produces.
   *
   * A blocking finding is a claim about a diff, and the diff is the first
   * thing that stops existing: blocked work gets stashed, passed work gets
   * committed and amended. Adjudicating "the reviewer said the test file was
   * modified" in the morning means having the diff it was actually looking at.
   */
  private captureDiff(taskId: string, attempt: number, evidence: string[]): void {
    if (!this.opts.artifacts) return;
    try {
      const diff = this.opts.artifacts.write(taskId, attempt, 'diff.patch', git.pendingDiff(this.opts.cwd));
      const stat = this.opts.artifacts.write(
        taskId,
        attempt,
        'diff.stat.txt',
        `${git.pendingDiffStat(this.opts.cwd)}\n`,
      );
      evidence.push(diff.path, stat.path);
    } catch (err) {
      // Evidence is worth a lot and not worth the run. A repository state git
      // cannot diff is a problem the gates and the reviewer will find anyway.
      this.opts.journal.event('artifact_failed', {
        taskId,
        attempt,
        artifact: 'diff',
        error: (err as Error).message,
      });
    }
  }

  /**
   * Run the builder with everything it does written down as it happens.
   *
   * The builder is the longest and least visible part of a task — a single
   * subprocess that can run for half an hour. Three things come out of it here
   * that did not before: the command line and pid the moment it exists, its
   * streams persisted while they arrive rather than after it exits, and its
   * tool calls as individual events. The middle one is what survives a crash.
   */
  private async invokeBuilder(
    taskId: string,
    attempt: number,
    prompt: string,
    evidence: string[],
  ): Promise<
    AgentRun & { toolCalls: number; toolEventsPath?: string; stdoutPath?: string; stderrPath?: string }
  > {
    const artifacts = this.opts.artifacts;
    const stdout = artifacts?.sink(taskId, attempt, 'builder.stdout.log');
    const stderr = artifacts?.sink(taskId, attempt, 'builder.stderr.log');
    const tools = artifacts?.sink(taskId, attempt, 'builder.tools.jsonl');
    const started = Date.now();
    let toolCalls = 0;

    try {
      const run = await this.builder.invoke(prompt, {
        cwd: this.opts.cwd,
        systemPrompt: this.systemPrompt('builder'),
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
        onSpawn: ({ commandLine, pid }) => {
          this.commandStart({
            type: 'command_start',
            taskId,
            attempt,
            phase: 'builder',
            name: this.builder.label,
            command: commandLine,
            ...(pid !== undefined ? { pid } : {}),
            ...(stdout ? { stdoutPath: stdout.path } : {}),
            ...(stderr ? { stderrPath: stderr.path } : {}),
          });
        },
        onOutput: (stream, chunk) => {
          (stream === 'stdout' ? stdout : stderr)?.write(chunk);
          // The builder's stdout is a JSONL transcript, not something a human
          // reads; --verbose surfaces its tool calls instead, and only stderr
          // is worth echoing raw.
          if (stream === 'stderr') {
            this.emit({
              type: 'output',
              taskId,
              attempt,
              phase: 'builder',
              name: this.builder.label,
              stream,
              chunk,
            });
          }
        },
        onToolEvent: (tool) => {
          toolCalls += 1;
          tools?.write(`${JSON.stringify({ ...tool, taskId, attempt })}\n`);
          this.emit({ type: 'tool_event', taskId, attempt, tool });
        },
      });

      this.commandEnd({
        type: 'command_end',
        taskId,
        attempt,
        phase: 'builder',
        name: this.builder.label,
        ok: run.ok,
        durationMs: Date.now() - started,
        ...(stdout ? { stdoutPath: stdout.path } : {}),
        ...(stderr ? { stderrPath: stderr.path } : {}),
      });

      for (const ref of [stdout?.close(), stderr?.close(), toolCalls > 0 ? tools?.close() : undefined]) {
        if (ref) evidence.push(ref.path);
      }

      return {
        ...run,
        toolCalls,
        ...(tools && toolCalls > 0 ? { toolEventsPath: tools.path } : {}),
        ...(stdout ? { stdoutPath: stdout.path } : {}),
        ...(stderr ? { stderrPath: stderr.path } : {}),
      };
    } catch (err) {
      // A builder that could not be spawned at all still leaves a trace, and
      // the run continues to treat it as a failed attempt rather than dying.
      stdout?.close();
      stderr?.close();
      const message = (err as Error).message;
      this.commandEnd({
        type: 'command_end',
        taskId,
        attempt,
        phase: 'builder',
        name: this.builder.label,
        ok: false,
        durationMs: Date.now() - started,
      });
      return {
        text: '',
        ok: false,
        costUsd: 0,
        costKnown: true,
        durationMs: Date.now() - started,
        toolEventsSupported: false,
        error: `the worker could not be started: ${message}`,
        toolCalls,
      };
    }
  }

  private systemPrompt(role: 'builder' | 'reviewer'): string {
    const agent =
      role === 'builder' ? this.opts.config.agents.builder : this.opts.config.agents.reviewer;
    const extra = agent?.system_prompt_append;
    return extra ? `${AUTONOMY_CONTRACT}\n\n## Project-specific instructions\n\n${extra}` : AUTONOMY_CONTRACT;
  }

  async run(): Promise<RunSummary> {
    const { cwd, config, plan, store, journal } = this.opts;
    const tasks = topoOrder(plan);

    const baseCommit = git.headSha(cwd);
    const branch = this.setupBranch();
    const runDir = this.opts.artifacts ? this.opts.artifacts.rel(this.opts.artifacts.dir) : undefined;
    store.setRunMeta({ baseCommit, ...(branch ? { branch } : {}), ...(runDir ? { runDir } : {}) });
    // Scaffold the decision record directory and its index before any task
    // runs, so the first worker has somewhere to write and something to read.
    refreshAdrIndex(cwd);
    this.refreshBoard();
    // Land Kalfa's own bookkeeping in its own commit, so the first task starts
    // from a clean tree and no worker's diff is polluted by it.
    this.commitBookkeeping(`kalfa: begin run ${this.opts.runId}`);
    journal.event('run_start', {
      total: tasks.length,
      branch,
      baseCommit,
      goal: plan.goal,
      runDir,
      order: tasks.map((t) => t.id),
    });
    this.emit({
      type: 'run_start',
      total: tasks.length,
      ...(branch ? { branch } : {}),
      ...(runDir ? { runDir } : {}),
    });

    let consecutiveBlocks = 0;
    let stoppedEarly: string | undefined;

    for (const [index, task] of tasks.entries()) {
      if (this.opts.signal?.aborted) {
        stoppedEarly = 'aborted by user';
        break;
      }

      const ceiling = config.policy.max_run_cost_usd;
      if (ceiling !== undefined && store.totalCostUsd() >= ceiling) {
        stoppedEarly = `run cost ceiling $${ceiling.toFixed(2)} reached`;
        break;
      }

      // Resume: a task committed by an earlier attempt at this run id is done.
      if (store.isDone(task.id)) {
        this.emit({ type: 'task_done', taskId: task.id, status: 'done' });
        continue;
      }

      const unmet = task.deps.filter((dep) => !store.isDone(dep));
      if (unmet.length > 0) {
        const reason = `dependencies not satisfied: ${unmet.join(', ')}`;
        store.setStatus(task.id, 'skipped', { reason });
        this.refreshBoard();
        journal.event('task_skipped', { taskId: task.id, reason });
        journal.recordBlocked(task.id, task.title, reason);
        this.commitBookkeeping(`kalfa: skipped ${task.id}`);
        this.emit({ type: 'task_done', taskId: task.id, status: 'skipped', reason });
        continue;
      }

      this.emit({ type: 'task_start', task, index, total: tasks.length });
      const status = await this.runTask(task);

      if (status === 'done') {
        consecutiveBlocks = 0;
      } else {
        consecutiveBlocks += 1;
        if (consecutiveBlocks >= config.policy.abort_after_consecutive_blocks) {
          stoppedEarly = `${consecutiveBlocks} consecutive tasks blocked — stopping rather than burning budget`;
          break;
        }
      }
    }

    const counts = store.counts();
    const costUsd = store.totalCostUsd();
    store.setRunMeta({
      finishedAt: new Date().toISOString(),
      ...(stoppedEarly ? { stoppedEarly } : {}),
    });
    this.refreshBoard();
    // Without this the final board is left uncommitted, and the NEXT run
    // refuses to start on a dirty tree.
    this.commitBookkeeping(`kalfa: finish run ${this.opts.runId}`);
    journal.event('run_end', { counts, costUsd, stoppedEarly });
    this.emit({ type: 'run_end', counts, costUsd });

    return {
      counts,
      costUsd,
      ...(branch ? { branch } : {}),
      baseCommit,
      ...(stoppedEarly ? { stoppedEarly } : {}),
    };
  }

  /**
   * Record once that a total is a floor, not a bill.
   *
   * The codex CLI does not report per-run cost, so a run with a codex reviewer
   * spends more than it reports. Under-reporting would be bad on its own; it
   * also means `max_run_cost_usd` is enforced against builder spend alone, and
   * anyone who set a ceiling deserves to be told that.
   */
  private noteCostIncomplete(): void {
    if (this.opts.store.run.costIncomplete) return;
    this.opts.store.setRunMeta({ costIncomplete: true });
  }

  /**
   * Re-render TASKS.md. Called after every status change so a run killed
   * mid-task still leaves an accurate board on disk.
   */
  private refreshBoard(): void {
    writeBoard(this.opts.cwd, this.opts.plan, this.opts.store.run);
  }

  /**
   * Tasks already committed in this run, in plan order. Titles only — the
   * code itself is in the repository, and re-summarizing it into the prompt
   * would be both expensive and a worse source than reading it.
   */
  /**
   * Tasks still to come, so the reviewer can spot a change that paints one of
   * them into a corner. It sees a diff and nothing else otherwise.
   */
  private remainingAfter(current: Task): Array<{ id: string; title: string }> {
    const ordered = topoOrder(this.opts.plan);
    const index = ordered.findIndex((t) => t.id === current.id);
    return ordered
      .slice(index + 1)
      .filter((task) => !this.opts.store.isDone(task.id))
      .map((task) => ({ id: task.id, title: task.title }));
  }

  private completedSoFar(): Array<{ id: string; title: string }> {
    return topoOrder(this.opts.plan)
      .filter((task) => this.opts.store.isDone(task.id))
      .map((task) => ({ id: task.id, title: task.title }));
  }

  /**
   * Commit Kalfa's own artifacts (TASKS.md, the ADR index, BLOCKED.md) apart from
   * any task. Keeps the report in history and the tree clean between tasks.
   */
  private commitBookkeeping(message: string): void {
    if (!this.opts.config.policy.commit_per_task) return;
    if (git.isClean(this.opts.cwd)) return;
    git.commitAll(this.opts.cwd, message);
  }

  /** Cut the run's branch, unless configured to work in place. */
  private setupBranch(): string | undefined {
    const { cwd, config, runId } = this.opts;
    if (config.policy.use_current_branch) return git.currentBranch(cwd);

    const name = config.policy.branch.replace('{run_id}', runId);
    if (git.branchExists(cwd, name)) return git.currentBranch(cwd);
    git.createBranch(cwd, name);
    return name;
  }

  private async runTask(task: Task): Promise<TaskStatus> {
    const { cwd, config, store, journal } = this.opts;
    const gates = gatesForTask(config.gates, task.gates);
    const gateCommands = gates.map((g) => g.run);
    const wantsReview = task.review ?? config.policy.review;

    store.setStatus(task.id, 'running');
    const adrsBefore = readAdrs(cwd).length;
    this.refreshBoard();
    // Land the board BEFORE the builder starts.
    //
    // Found by the reviewer on the first run where it worked: the board is
    // rewritten when a task starts, `git add --all` swept it into the task
    // commit, and the reviewer — which reads the uncommitted diff — spent its
    // only finding complaining about Kalfa bookkeeping instead of the code.
    // Committing it up front leaves the builder and the reviewer looking at
    // nothing but the task's own work.
    this.commitBookkeeping(`kalfa: start ${task.id}`);
    journal.event('task_start', { taskId: task.id, title: task.title });

    let feedback: Feedback[] = [];
    // Every attempt's failure, not just the last, so a worker can recognise
    // when it is going round in circles.
    const prior: PriorAttempt[] = [];
    this.lastFeedback = [];
    this.lastReport = '';
    this.lastGateResults = [];
    this.lastArtifactsDir = undefined;
    this.lastEvidence = [];
    this.previousEvidence = [];

    for (let attempt = 1; attempt <= config.policy.max_attempts; attempt += 1) {
      if (this.opts.signal?.aborted) break;

      const attemptStart = Date.now();
      const headBefore = git.headSha(cwd);
      const artifactsDir = this.artifactsDir(task.id, attempt);
      const evidence: string[] = [];
      this.previousEvidence = this.lastEvidence;
      this.lastArtifactsDir = artifactsDir;
      this.lastEvidence = evidence;
      if (attempt > 1 && feedback.length > 0) {
        prior.push({ attempt: attempt - 1, feedback: [...feedback] });
      }
      this.emit({
        type: 'attempt_start',
        taskId: task.id,
        attempt,
        max: config.policy.max_attempts,
        ...(artifactsDir ? { artifactsDir } : {}),
      });
      // Journalled on entry, not on completion. An attempt is only added to
      // the task record once it finishes, so a run killed mid-builder used to
      // leave no trace of it at all — the board showed a task with one fewer
      // attempt than it had really made, and the interrupted work looked
      // like it came from nowhere.
      journal.event('attempt_start', { taskId: task.id, attempt, headBefore, artifactsDir });

      if (attempt > 1 && feedback.length > 0) {
        // Without this a retry can appear in the log with no explanation at
        // all — a builder line, then a bare `retry 2/3`. The reason existed
        // internally and never reached the operator.
        //
        // The cause now cites the previous attempt's directory as well: a
        // one-line summary of a failure is a pointer, and a pointer to nowhere
        // is what made the old line unfalsifiable.
        const causedBy = this.artifactsDir(task.id, attempt - 1);
        const retryEvent = {
          type: 'retrying' as const,
          taskId: task.id,
          attempt,
          reason: feedback
            .map((f) => {
              const firstLine = f.detail.split('\n').find((l) => l.trim()) ?? '';
              return `${f.source}: ${firstLine}`;
            })
            .join('; ')
            .slice(0, 200),
          ...(causedBy ? { causedBy } : {}),
          ...(this.previousEvidence.length > 0 ? { evidence: [...this.previousEvidence] } : {}),
        };
        this.emit(retryEvent);
        journal.event('retry_decision', {
          taskId: task.id,
          attempt,
          causedBy,
          evidence: this.previousEvidence,
          feedback: feedback.map((f) => ({ kind: f.kind, source: f.source, detail: f.detail })),
        });
      }

      this.phase(task.id, attempt, 'preparing');
      const prompt =
        attempt === 1
          ? taskPrompt(
              task,
              gateCommands,
              this.completedSoFar(),
              adrInstructions(nextAdrNumber(cwd), task.id),
            )
          : retryPrompt(
              task,
              attempt,
              feedback,
              prior,
              gateCommands,
              adrInstructions(nextAdrNumber(cwd), task.id),
            );
      if (this.opts.config.observability.capture_prompts) {
        const ref = this.opts.artifacts?.write(task.id, attempt, 'builder.prompt.md', prompt);
        if (ref) evidence.push(ref.path);
      }

      this.phase(task.id, attempt, 'builder', this.builder.label);
      const run = await this.invokeBuilder(task.id, attempt, prompt, evidence);

      this.lastReport = run.text;
      if (!run.costKnown) this.noteCostIncomplete();
      const reportRef = this.opts.artifacts?.write(
        task.id,
        attempt,
        'builder.report.md',
        run.text || '(the worker produced no final message)\n',
      );
      if (reportRef) evidence.push(reportRef.path);

      this.emit({
        type: 'agent_done',
        taskId: task.id,
        attempt,
        ok: run.ok,
        costUsd: run.costUsd,
        durationMs: run.durationMs,
        toolCalls: run.toolCalls,
        toolEventsSupported: run.toolEventsSupported,
        ...(run.stdoutPath ? { stdoutPath: run.stdoutPath } : {}),
        ...(run.error ? { error: run.error } : {}),
      });
      journal.event('agent_done', {
        taskId: task.id,
        attempt,
        phase: 'builder' satisfies Phase,
        ok: run.ok,
        costUsd: run.costUsd,
        durationMs: run.durationMs,
        toolCalls: run.toolCalls,
        toolEventsSupported: run.toolEventsSupported,
        stdoutPath: run.stdoutPath,
        stderrPath: run.stderrPath,
        toolEventsPath: run.toolEventsPath,
        reportPath: reportRef?.path,
        error: run.error,
        summary: run.text.slice(0, 2000),
      });

      const record = (outcome: AttemptRecord['outcome'], extra: Partial<AttemptRecord> = {}): void =>
        store.addAttempt(task.id, {
          attempt,
          agentCostUsd: run.costUsd,
          reviewCostUsd: 0,
          durationMs: Date.now() - attemptStart,
          gates: [],
          reviewFindings: 0,
          blockingFindings: 0,
          outcome,
          ...(artifactsDir ? { artifactsDir } : {}),
          ...extra,
        });

      if (!run.ok) {
        record('agent_failed');
        feedback = this.lastFeedback = [
          { kind: 'agent', source: this.builder.label, detail: run.error ?? 'worker failed' },
        ];
        this.recordDecision(task.id, attempt, {
          outcome: 'agent_failed',
          next: attempt < config.policy.max_attempts ? 'retry' : 'block',
          reason: run.error ?? 'worker failed',
          evidence,
        });
        continue;
      }

      // A worker that committed its own work has broken the invariant the rest
      // of the pipeline depends on: the gates and the reviewer expect the
      // task's changes to be uncommitted, and the reviewer literally reads
      // `git diff HEAD`. Left alone this reads as "produced nothing" — a live
      // run burned two retries and blocked a task whose finished
      // implementation was sitting at HEAD, ungated and unreviewed.
      //
      // Soft-resetting puts the content back in the tree byte for byte.
      if (git.headSha(cwd) !== headBefore) {
        git.softResetTo(cwd, headBefore);
        journal.event('worker_commit_undone', { taskId: task.id, attempt, headBefore });
        this.emit({ type: 'worker_committed', taskId: task.id });
      }

      // "Has this task produced any work at all?" — measured against the last
      // commit, NOT against the start of this attempt.
      //
      // Measuring per-attempt was wrong and cost real work: a retry that
      // correctly concluded the earlier attempt was already right, and
      // changed nothing, was scored as having done nothing. The task then
      // exhausted its attempts and its perfectly good fix was stashed.
      if (git.treeHash(cwd) === git.headTreeHash(cwd)) {
        record('agent_failed');
        feedback = this.lastFeedback = [
          {
            kind: 'agent',
            source: this.builder.label,
            detail:
              'Your previous attempt left the working tree unchanged. No files were ' +
              'created or modified. Implement the task by editing files on disk.',
          },
        ];
        this.recordDecision(task.id, attempt, {
          outcome: 'agent_failed',
          next: attempt < config.policy.max_attempts ? 'retry' : 'block',
          reason: 'the working tree was unchanged relative to the last commit',
          evidence,
        });
        continue;
      }

      // The worker may have written decision records. Re-index before the
      // gates run, so a stale index never reaches the next task.
      refreshAdrIndex(cwd);

      // Captured before the gates, because a gate is allowed to write files
      // (a formatter, a snapshot update) and the diff the reviewer will be
      // shown is the one that matters for the finding it makes.
      this.phase(task.id, attempt, 'collecting_diff');
      this.captureDiff(task.id, attempt, evidence);

      const gateResults =
        gates.length > 0
          ? await runGates(gates, cwd, this.opts.signal, this.gateObserver(task.id, attempt))
          : [];
      this.lastGateResults = gateResults;
      for (const gate of gateResults) {
        if (gate.stdoutPath) evidence.push(gate.stdoutPath);
        if (gate.stderrPath) evidence.push(gate.stderrPath);
      }
      this.emit({ type: 'gates_done', taskId: task.id, attempt, results: gateResults });
      journal.event('gates_done', {
        taskId: task.id,
        attempt,
        phase: 'gate' satisfies Phase,
        results: gateResults.map((g) => ({
          name: g.name,
          ok: g.ok,
          exitCode: g.exitCode,
          command: g.command,
          durationMs: g.durationMs,
          skipped: g.skipped,
          stdoutPath: g.stdoutPath,
          stderrPath: g.stderrPath,
        })),
      });

      const failed = blockingFailures(gateResults, gates);
      if (failed.length > 0) {
        record('gate_failed', { gates: gateResults });
        feedback = this.lastFeedback = failed.map((g) => ({
          kind: 'gate' as const,
          source: g.name,
          detail: g.output || `exited ${g.exitCode} with no output`,
        }));
        this.recordDecision(task.id, attempt, {
          outcome: 'gate_failed',
          next: attempt < config.policy.max_attempts ? 'retry' : 'block',
          reason: failed.map((g) => `${g.name} exited ${g.exitCode}`).join(', '),
          gates: failed.map((g) => ({
            name: g.name,
            command: g.command,
            exitCode: g.exitCode,
            stdoutPath: g.stdoutPath,
            stderrPath: g.stderrPath,
          })),
          evidence,
        });
        continue;
      }

      // Detected before the review, because it changes what the review is
      // told to do: a test that moves with the implementation is the one thing
      // a reviewer must not take on trust.
      // Read once and used twice: the files this diff touches decide both what
      // the reviewer is warned about and, afterwards, which of its findings
      // survive. Both have to be looking at the same tree the reviewer will.
      const pendingFiles = git.pendingFiles(cwd);
      const touchedProtected = protectedAmong(pendingFiles, config.policy.protected_paths);
      if (touchedProtected.length > 0) {
        store.setStatus(task.id, 'running', { protectedPaths: touchedProtected });
        this.refreshBoard();
        journal.event('protected_paths_touched', {
          taskId: task.id,
          attempt,
          files: touchedProtected,
        });
        this.emit({ type: 'protected_touched', taskId: task.id, files: touchedProtected });
      }
      const callout =
        touchedProtected.length > 0 ? protectedPathsCallout(touchedProtected) : undefined;

      if (wantsReview && this.reviewer) {
        this.phase(task.id, attempt, 'review', this.reviewer.label);
        const review = await this.invokeReview({
          task,
          attempt,
          gateCommands,
          callout,
          evidence,
          changedFiles: pendingFiles,
        });
        this.emit({
          type: 'review_done',
          taskId: task.id,
          attempt,
          findings: review.findings.length,
          blocking: review.blocking.length,
          details: review.findings,
          ...(review.error ? { error: review.error } : {}),
          ...(review.findingsPath ? { findingsPath: review.findingsPath } : {}),
          ...(review.rawPath ? { rawPath: review.rawPath } : {}),
        });
        if (!review.costKnown) this.noteCostIncomplete();
        journal.event('review_done', {
          taskId: task.id,
          attempt,
          phase: 'review' satisfies Phase,
          findings: review.findings,
          blocking: review.blocking.length,
          error: review.error,
          findingsPath: review.findingsPath,
          rawPath: review.rawPath,
        });

        if (review.error) {
          // A reviewer that cannot run must not be a silent pass. It is also
          // not the builder's fault, so it does not consume a retry as a code
          // failure — it is surfaced and the task is blocked.
          store.addAttempt(task.id, {
            attempt,
            agentCostUsd: run.costUsd,
            reviewCostUsd: review.costUsd,
            durationMs: Date.now() - attemptStart,
            gates: gateResults,
            reviewFindings: 0,
            blockingFindings: 0,
            outcome: 'review_failed',
            ...(artifactsDir ? { artifactsDir } : {}),
          });
          this.recordDecision(task.id, attempt, {
            outcome: 'review_failed',
            next: 'block',
            reason: `reviewer could not run: ${review.error}`,
            evidence,
          });
          return this.blockTask(task, `reviewer could not run: ${review.error}`, adrsBefore);
        }

        let blocking = review.blocking;
        let reviewCostUsd = review.costUsd;

        // Second opinion, but only where it changes the outcome.
        //
        // On the last attempt a blocking finding does not cost a retry, it
        // costs the work: everything gets stashed. And a reviewer is not an
        // oracle — one was observed inventing a blocker ("the test file was
        // modified" when git showed it untouched), then withdrawing it when
        // asked again with nothing changed. Re-asking once, when the gates
        // are green and the alternative is throwing the work away, is worth
        // one extra review call.
        const lastChance = attempt === config.policy.max_attempts;
        if (blocking.length > 0 && lastChance && config.policy.review_second_opinion) {
          this.emit({ type: 'second_opinion', taskId: task.id, attempt });
          this.phase(task.id, attempt, 'second_opinion', this.reviewer.label);
          const second = await this.invokeReview({
            task,
            attempt,
            gateCommands,
            callout,
            evidence,
            changedFiles: pendingFiles,
            second: true,
          });
          if (!second.costKnown) this.noteCostIncomplete();
          reviewCostUsd += second.costUsd;
          journal.event('second_opinion', {
            taskId: task.id,
            attempt,
            phase: 'second_opinion' satisfies Phase,
            firstFindings: review.blocking,
            secondFindings: second.blocking,
            error: second.error,
            findingsPath: second.findingsPath,
            rawPath: second.rawPath,
            withdrawn: !second.error && second.blocking.length === 0,
          });
          // Only a clean second read overturns the block. An unreadable one
          // is not evidence of anything, so the original finding stands.
          if (!second.error && second.blocking.length === 0) {
            blocking = [];
            this.emit({
              type: 'review_done',
              taskId: task.id,
              attempt,
              findings: second.findings.length,
              blocking: 0,
              details: second.findings,
              ...(second.findingsPath ? { findingsPath: second.findingsPath } : {}),
            });
          }
        }

        if (blocking.length > 0) {
          store.addAttempt(task.id, {
            attempt,
            agentCostUsd: run.costUsd,
            reviewCostUsd,
            durationMs: Date.now() - attemptStart,
            gates: gateResults,
            reviewFindings: review.findings.length,
            blockingFindings: blocking.length,
            outcome: 'review_failed',
            ...(artifactsDir ? { artifactsDir } : {}),
          });
          feedback = this.lastFeedback = [
            {
              kind: 'review',
              source: this.reviewer.label,
              detail: formatFindings(blocking),
            },
          ];
          this.recordDecision(task.id, attempt, {
            outcome: 'review_failed',
            next: attempt < config.policy.max_attempts ? 'retry' : 'block',
            reason: formatFindings(blocking),
            blocking,
            evidence,
          });
          continue;
        }

        record('passed', {
          gates: gateResults,
          reviewCostUsd,
          reviewFindings: review.findings.length,
        });
      } else {
        record('passed', { gates: gateResults });
      }

      this.recordDecision(task.id, attempt, { outcome: 'passed', next: 'commit', evidence });
      return this.completeTask(task, attempt, adrsBefore);
    }

    return this.blockTask(
      task,
      `no attempt passed verification in ${config.policy.max_attempts} attempts`,
      adrsBefore,
    );
  }

  private completeTask(task: Task, attempt: number, adrsBefore = 0): TaskStatus {
    const { cwd, config, store, journal } = this.opts;
    const adrsWritten = Math.max(0, readAdrs(cwd).length - adrsBefore);
    const artifactsDir = this.artifactsDir(task.id, attempt);

    if (!config.policy.commit_per_task) {
      store.setStatus(task.id, 'done', { adrsWritten });
      this.refreshBoard();
      journal.event('task_done', { taskId: task.id, attempt, artifactsDir });
      this.emit({
        type: 'task_done',
        taskId: task.id,
        status: 'done',
        ...(artifactsDir ? { artifactsDir } : {}),
      });
      return 'done';
    }

    this.phase(task.id, attempt, 'commit');

    const message = [
      `${task.id}: ${task.title}`,
      '',
      task.details.trim().slice(0, 500),
      '',
      `kalfa-run: ${this.opts.runId}`,
      `kalfa-attempts: ${attempt}`,
    ]
      .join('\n')
      .trim();

    const commit = git.commitAll(cwd, message);
    store.setStatus(task.id, 'done', { adrsWritten, ...(commit ? { commit } : {}) });
    this.refreshBoard();
    journal.event('task_done', { taskId: task.id, attempt, commit, artifactsDir });
    this.emit({
      type: 'task_done',
      taskId: task.id,
      status: 'done',
      ...(commit ? { commit } : {}),
      ...(artifactsDir ? { artifactsDir } : {}),
    });
    return 'done';
  }

  /**
   * What the human needs in order to adjudicate, in the morning, in a minute.
   *
   * A live run produced a reviewer blocker that was simply false — it claimed
   * a test file had been modified when git showed it untouched. The builder
   * rebutted it correctly, and Kalfa threw the rebuttal away: BLOCKED.md said
   * only "no attempt passed verification". Whoever read that had no way to
   * know the work was fine and the reviewer was wrong.
   *
   * So the last thing that stopped it, and the worker's answer to it, are
   * both recorded. Gate status is called out separately because "gates green,
   * review blocked" is the shape of a disputed finding.
   */
  private blockedDetail(): string | undefined {
    const parts: string[] = [];

    if (this.lastGateResults.length > 0) {
      const failed = this.lastGateResults.filter((g) => !g.ok && !g.skipped).map((g) => g.name);
      parts.push(
        failed.length === 0
          ? 'GATES: all passed on the final attempt.'
          : `GATES: failed — ${failed.join(', ')}`,
      );
    }

    for (const item of this.lastFeedback) {
      parts.push(`${item.kind.toUpperCase()} (${item.source}):\n${item.detail.slice(0, 1500)}`);
    }

    // Where the untruncated version of everything above lives. Each section of
    // this report is a summary of a file, and the operator adjudicating a
    // disputed blocker at 9am needs the file, not the summary.
    if (this.lastArtifactsDir) {
      parts.push(
        [
          `FULL EVIDENCE: ${this.lastArtifactsDir}/`,
          ...[...new Set(this.lastEvidence)].map((path) => `  ${path}`),
        ].join('\n'),
      );
    }

    if (this.lastReport) {
      parts.push(
        `WORKER'S FINAL REPORT:\n${this.lastReport.slice(0, 1500)}\n\n` +
          `If the worker is right and the blocker above is wrong, ` +
          // The recovery hint has to match reality. It once told a tired
          // operator the work was in the stash when the stash was empty,
          // sending them to look in the wrong place at the worst moment.
          (this.lastStashRef
            ? `the work is in the stash below and only needs committing.`
            : `check \`git log\` and \`git status\` for where the work ended up — ` +
              `nothing was stashed for this task.`),
      );
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  private blockTask(task: Task, reason: string, adrsBefore = 0): TaskStatus {
    const { cwd, config, store, journal } = this.opts;

    const attempt = store.task(task.id).attempts.length;

    /**
     * Counted here, before the stash, because the stash takes them with it.
     *
     * Only completed tasks used to have their decision records counted, which
     * got the accounting exactly backwards: a task that blocked is the one
     * whose reasoning matters most, and it is also the one whose reasoning is
     * about to be parked in a stash where nobody will look for it. Observed on
     * a benchmark run — the builder hit a plan it could not satisfy, wrote two
     * records totalling 180 lines arguing its way to a decision, and the board
     * reported that the run had produced none.
     */
    const adrsWritten = Math.max(0, readAdrs(cwd).length - adrsBefore);

    let stashRef: string | undefined;
    if (config.policy.stash_failed_work && !git.isClean(cwd)) {
      this.phase(task.id, attempt, 'stash');
      stashRef = git.stashAll(cwd, `kalfa ${this.opts.runId} blocked ${task.id}`);
    }
    this.phase(task.id, attempt, 'blocked', reason);
    this.lastStashRef = stashRef;

    store.setStatus(task.id, 'blocked', {
      reason,
      ...(adrsWritten > 0 ? { adrsWritten } : {}),
      ...(stashRef ? { stashRef } : {}),
    });
    // After the stash, never before: `git stash push -u` would sweep the
    // board away with the abandoned work, losing the record of the failure.
    this.refreshBoard();
    journal.event('task_blocked', {
      taskId: task.id,
      attempt,
      reason,
      adrsWritten,
      stashRef,
      artifactsDir: this.lastArtifactsDir,
      evidence: [...new Set(this.lastEvidence)],
    });
    const detail = [
      this.blockedDetail(),
      // The records are the worker's own account of why it did what it did,
      // and on a blocked task they are inside the stash rather than the tree.
      // A report that points at the stash without saying they are in it sends
      // the reader straight past the reasoning.
      adrsWritten > 0
        ? `DECISIONS RECORDED: ${adrsWritten} — the worker's own account of its choices.\n` +
          (stashRef
            ? `  In the stash below, under docs/adr/. They are not in your tree.`
            : `  See docs/adr/.`)
        : undefined,
      stashRef
        ? [
            `ABANDONED WORK: parked in stash ${stashRef}`,
            `  git stash list          find it`,
            `  git stash apply         bring it back into the working tree`,
          ].join('\n')
        : undefined,
    ]
      .filter(Boolean)
      .join('\n\n');
    journal.recordBlocked(task.id, task.title, reason, detail || undefined);
    // BLOCKED.md is written after the stash on purpose: the report must survive
    // even though the work it describes was parked.
    this.commitBookkeeping(`kalfa: blocked ${task.id}`);
    this.emit({
      type: 'task_done',
      taskId: task.id,
      status: 'blocked',
      reason,
      ...(this.lastArtifactsDir ? { artifactsDir: this.lastArtifactsDir } : {}),
    });
    return 'blocked';
  }
}
