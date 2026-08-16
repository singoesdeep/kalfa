import type { KalfaConfig } from '../config/schema.js';
import type { Plan, Task } from '../plan/schema.js';
import { topoOrder } from '../plan/schema.js';
import { AgentInvoker } from '../agents/provider.js';
import { blockingFailures, gatesForTask, runGates } from '../gates/gates.js';
import { formatFindings, reviewTask } from '../review/review.js';
import { AUTONOMY_CONTRACT, retryPrompt, taskPrompt } from '../prompts/contract.js';
import { Journal } from '../journal/journal.js';
import { StateStore } from '../state/store.js';
import { writeBoard } from '../board/board.js';
import { adrInstructions, nextAdrNumber, refreshAdrIndex } from '../adr/adr.js';
import * as git from '../git/git.js';
import type { AttemptRecord, Feedback, GateResult, TaskStatus } from '../types.js';

export interface RunnerOptions {
  cwd: string;
  config: KalfaConfig;
  plan: Plan;
  planPath: string;
  runId: string;
  store: StateStore;
  journal: Journal;
  signal?: AbortSignal;
  /** Progress reporting. The CLI renders these; tests ignore them. */
  onEvent?: (event: RunnerEvent) => void;
  /** Injection seam for tests. Defaults to the real subprocess invoker. */
  makeInvoker?: (role: 'builder' | 'reviewer') => AgentInvoker;
}

export type RunnerEvent =
  | { type: 'run_start'; total: number; branch?: string }
  | { type: 'task_start'; task: Task; index: number; total: number }
  | { type: 'attempt_start'; taskId: string; attempt: number; max: number }
  | { type: 'agent_done'; taskId: string; ok: boolean; costUsd: number; durationMs: number }
  | { type: 'gates_done'; taskId: string; results: GateResult[] }
  | { type: 'review_done'; taskId: string; findings: number; blocking: number; error?: string }
  | { type: 'task_done'; taskId: string; status: TaskStatus; commit?: string; reason?: string }
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
    store.setRunMeta({ baseCommit, ...(branch ? { branch } : {}) });
    // Scaffold the decision record directory and its index before any task
    // runs, so the first worker has somewhere to write and something to read.
    refreshAdrIndex(cwd);
    this.refreshBoard();
    // Land Kalfa's own bookkeeping in its own commit, so the first task starts
    // from a clean tree and no worker's diff is polluted by it.
    this.commitBookkeeping(`kalfa: begin run ${this.opts.runId}`);
    journal.event('run_start', { total: tasks.length, branch, baseCommit, goal: plan.goal });
    this.emit({ type: 'run_start', total: tasks.length, ...(branch ? { branch } : {}) });

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
    store.setRunMeta({ finishedAt: new Date().toISOString() });
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

    for (let attempt = 1; attempt <= config.policy.max_attempts; attempt += 1) {
      if (this.opts.signal?.aborted) break;

      const attemptStart = Date.now();
      const treeBefore = git.treeHash(cwd);
      this.emit({
        type: 'attempt_start',
        taskId: task.id,
        attempt,
        max: config.policy.max_attempts,
      });

      const prompt =
        attempt === 1
          ? taskPrompt(
              task,
              gateCommands,
              this.completedSoFar(),
              adrInstructions(nextAdrNumber(cwd), task.id),
            )
          : retryPrompt(task, attempt, feedback);

      const run = await this.builder.invoke(prompt, {
        cwd,
        systemPrompt: this.systemPrompt('builder'),
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      });

      this.emit({
        type: 'agent_done',
        taskId: task.id,
        ok: run.ok,
        costUsd: run.costUsd,
        durationMs: run.durationMs,
      });
      journal.event('agent_done', {
        taskId: task.id,
        attempt,
        ok: run.ok,
        costUsd: run.costUsd,
        durationMs: run.durationMs,
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
          ...extra,
        });

      if (!run.ok) {
        record('agent_failed');
        feedback = [
          { kind: 'agent', source: this.builder.label, detail: run.error ?? 'worker failed' },
        ];
        continue;
      }

      // An unchanged tree means nothing was implemented. Treat it as a failure:
      // the alternative is an empty commit and a task marked done.
      if (git.treeHash(cwd) === treeBefore) {
        record('agent_failed');
        feedback = [
          {
            kind: 'agent',
            source: this.builder.label,
            detail:
              'Your previous attempt left the working tree unchanged. No files were ' +
              'created or modified. Implement the task by editing files on disk.',
          },
        ];
        continue;
      }

      // The worker may have written decision records. Re-index before the
      // gates run, so a stale index never reaches the next task.
      refreshAdrIndex(cwd);

      const gateResults = gates.length > 0 ? await runGates(gates, cwd, this.opts.signal) : [];
      this.emit({ type: 'gates_done', taskId: task.id, results: gateResults });
      journal.event('gates_done', {
        taskId: task.id,
        attempt,
        results: gateResults.map((g) => ({ name: g.name, ok: g.ok, exitCode: g.exitCode })),
      });

      const failed = blockingFailures(gateResults, gates);
      if (failed.length > 0) {
        record('gate_failed', { gates: gateResults });
        feedback = failed.map((g) => ({
          kind: 'gate' as const,
          source: g.name,
          detail: g.output || `exited ${g.exitCode} with no output`,
        }));
        continue;
      }

      if (wantsReview && this.reviewer) {
        const review = await reviewTask(
          this.reviewer,
          task,
          cwd,
          gateCommands,
          config.policy,
          this.opts.signal,
        );
        this.emit({
          type: 'review_done',
          taskId: task.id,
          findings: review.findings.length,
          blocking: review.blocking.length,
          ...(review.error ? { error: review.error } : {}),
        });
        journal.event('review_done', {
          taskId: task.id,
          attempt,
          findings: review.findings,
          error: review.error,
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
          });
          return this.blockTask(task, `reviewer could not run: ${review.error}`);
        }

        if (review.blocking.length > 0) {
          store.addAttempt(task.id, {
            attempt,
            agentCostUsd: run.costUsd,
            reviewCostUsd: review.costUsd,
            durationMs: Date.now() - attemptStart,
            gates: gateResults,
            reviewFindings: review.findings.length,
            blockingFindings: review.blocking.length,
            outcome: 'review_failed',
          });
          feedback = [
            {
              kind: 'review',
              source: this.reviewer.label,
              detail: formatFindings(review.blocking),
            },
          ];
          continue;
        }

        record('passed', {
          gates: gateResults,
          reviewCostUsd: review.costUsd,
          reviewFindings: review.findings.length,
        });
      } else {
        record('passed', { gates: gateResults });
      }

      return this.completeTask(task, attempt);
    }

    return this.blockTask(task, `no attempt passed verification in ${config.policy.max_attempts} attempts`);
  }

  private completeTask(task: Task, attempt: number): TaskStatus {
    const { cwd, config, store, journal } = this.opts;

    if (!config.policy.commit_per_task) {
      store.setStatus(task.id, 'done');
      this.refreshBoard();
      journal.event('task_done', { taskId: task.id, attempt });
      this.emit({ type: 'task_done', taskId: task.id, status: 'done' });
      return 'done';
    }

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
    store.setStatus(task.id, 'done', { ...(commit ? { commit } : {}) });
    this.refreshBoard();
    journal.event('task_done', { taskId: task.id, attempt, commit });
    this.emit({ type: 'task_done', taskId: task.id, status: 'done', ...(commit ? { commit } : {}) });
    return 'done';
  }

  private blockTask(task: Task, reason: string): TaskStatus {
    const { cwd, config, store, journal } = this.opts;

    let stashRef: string | undefined;
    if (config.policy.stash_failed_work && !git.isClean(cwd)) {
      stashRef = git.stashAll(cwd, `kalfa ${this.opts.runId} blocked ${task.id}`);
    }

    store.setStatus(task.id, 'blocked', {
      reason,
      ...(stashRef ? { stashRef } : {}),
    });
    // After the stash, never before: `git stash push -u` would sweep the
    // board away with the abandoned work, losing the record of the failure.
    this.refreshBoard();
    journal.event('task_blocked', { taskId: task.id, reason, stashRef });
    journal.recordBlocked(
      task.id,
      task.title,
      reason,
      stashRef ? `Abandoned work parked in stash ${stashRef} — recover with: git stash list` : undefined,
    );
    // BLOCKED.md is written after the stash on purpose: the report must survive
    // even though the work it describes was parked.
    this.commitBookkeeping(`kalfa: blocked ${task.id}`);
    this.emit({ type: 'task_done', taskId: task.id, status: 'blocked', reason });
    return 'blocked';
  }
}
