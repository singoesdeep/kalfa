import type { KalfaConfig } from '../config/schema.js';
import type { Plan, Task } from '../plan/schema.js';
import { topoOrder } from '../plan/schema.js';
import { AgentInvoker } from '../agents/provider.js';
import { blockingFailures, gatesForTask, runGates } from '../gates/gates.js';
import { protectedAmong, protectedPathsCallout } from '../gates/protected.js';
import { formatFindings, reviewTask } from '../review/review.js';
import {
  AUTONOMY_CONTRACT,
  retryPrompt,
  taskPrompt,
  type PriorAttempt,
} from '../prompts/contract.js';
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
  | { type: 'second_opinion'; taskId: string }
  | { type: 'protected_touched'; taskId: string; files: string[] }
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
  /** Carried out of the attempt loop so a blocked task can explain itself. */
  private lastFeedback: Feedback[] = [];
  private lastReport = '';
  private lastGateResults: GateResult[] = [];

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

    for (let attempt = 1; attempt <= config.policy.max_attempts; attempt += 1) {
      if (this.opts.signal?.aborted) break;

      const attemptStart = Date.now();
      if (attempt > 1 && feedback.length > 0) {
        prior.push({ attempt: attempt - 1, feedback: [...feedback] });
      }
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
          : retryPrompt(
              task,
              attempt,
              feedback,
              prior,
              gateCommands,
              adrInstructions(nextAdrNumber(cwd), task.id),
            );

      const run = await this.builder.invoke(prompt, {
        cwd,
        systemPrompt: this.systemPrompt('builder'),
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      });

      this.lastReport = run.text;
      if (!run.costKnown) this.noteCostIncomplete();
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
        feedback = this.lastFeedback = [
          { kind: 'agent', source: this.builder.label, detail: run.error ?? 'worker failed' },
        ];
        continue;
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
        continue;
      }

      // The worker may have written decision records. Re-index before the
      // gates run, so a stale index never reaches the next task.
      refreshAdrIndex(cwd);

      const gateResults = gates.length > 0 ? await runGates(gates, cwd, this.opts.signal) : [];
      this.lastGateResults = gateResults;
      this.emit({ type: 'gates_done', taskId: task.id, results: gateResults });
      journal.event('gates_done', {
        taskId: task.id,
        attempt,
        results: gateResults.map((g) => ({ name: g.name, ok: g.ok, exitCode: g.exitCode })),
      });

      const failed = blockingFailures(gateResults, gates);
      if (failed.length > 0) {
        record('gate_failed', { gates: gateResults });
        feedback = this.lastFeedback = failed.map((g) => ({
          kind: 'gate' as const,
          source: g.name,
          detail: g.output || `exited ${g.exitCode} with no output`,
        }));
        continue;
      }

      // Detected before the review, because it changes what the review is
      // told to do: a test that moves with the implementation is the one thing
      // a reviewer must not take on trust.
      const touchedProtected = protectedAmong(
        git.pendingFiles(cwd),
        config.policy.protected_paths,
      );
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
        const review = await reviewTask(
          this.reviewer,
          task,
          cwd,
          gateCommands,
          config.policy,
          this.opts.signal,
          callout,
          this.remainingAfter(task),
        );
        this.emit({
          type: 'review_done',
          taskId: task.id,
          findings: review.findings.length,
          blocking: review.blocking.length,
          ...(review.error ? { error: review.error } : {}),
        });
        if (!review.costKnown) this.noteCostIncomplete();
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
          this.emit({ type: 'second_opinion', taskId: task.id });
          const second = await reviewTask(
            this.reviewer,
            task,
            cwd,
            gateCommands,
            config.policy,
            this.opts.signal,
            callout,
            this.remainingAfter(task),
          );
          if (!second.costKnown) this.noteCostIncomplete();
          reviewCostUsd += second.costUsd;
          journal.event('second_opinion', {
            taskId: task.id,
            attempt,
            firstFindings: review.blocking,
            secondFindings: second.blocking,
            error: second.error,
            withdrawn: !second.error && second.blocking.length === 0,
          });
          // Only a clean second read overturns the block. An unreadable one
          // is not evidence of anything, so the original finding stands.
          if (!second.error && second.blocking.length === 0) {
            blocking = [];
            this.emit({
              type: 'review_done',
              taskId: task.id,
              findings: second.findings.length,
              blocking: 0,
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
          });
          feedback = this.lastFeedback = [
            {
              kind: 'review',
              source: this.reviewer.label,
              detail: formatFindings(blocking),
            },
          ];
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

    if (this.lastReport) {
      parts.push(
        `WORKER'S FINAL REPORT:\n${this.lastReport.slice(0, 1500)}\n\n` +
          `If the worker is right and the blocker above is wrong, the work is in ` +
          `the stash and only needs committing.`,
      );
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined;
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
    const detail = [
      this.blockedDetail(),
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
    this.emit({ type: 'task_done', taskId: task.id, status: 'blocked', reason });
    return 'blocked';
  }
}
