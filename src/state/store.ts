import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRecord, RunRecord, TaskRecord, TaskStatus } from '../types.js';
import { ensureStateDir } from './dir.js';

/**
 * Run state, so a run that dies at 3am can be resumed at 9am without redoing
 * the work that already passed and committed.
 *
 * Written atomically: a half-written state file after a crash would be worse
 * than none, because resume would silently skip tasks.
 */
export class StateStore {
  private readonly path: string;
  private readonly dir: string;
  private record: RunRecord;

  constructor(
    private readonly cwd: string,
    runId: string,
    planPath: string,
    private readonly stateDir = '.kalfa',
  ) {
    this.dir = ensureStateDir(cwd, stateDir);
    this.path = join(this.dir, 'state.json');
    this.record = this.load(runId, planPath);
  }

  private load(runId: string, planPath: string): RunRecord {
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as RunRecord;
        if (parsed.runId === runId) return parsed;
      } catch {
        // Corrupt state is discarded rather than guessed at.
      }
    }
    return { runId, startedAt: new Date().toISOString(), planPath, tasks: {} };
  }

  get run(): RunRecord {
    return this.record;
  }

  private flush(): void {
    // Re-assert the directory: an agent running loose in the repo can delete
    // it, and losing run state mid-run costs more than an extra syscall.
    ensureStateDir(this.cwd, this.stateDir);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.record, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  setRunMeta(
    meta: Partial<Pick<RunRecord, 'branch' | 'baseCommit' | 'finishedAt' | 'costIncomplete'>>,
  ): void {
    Object.assign(this.record, meta);
    this.flush();
  }

  task(id: string): TaskRecord {
    let record = this.record.tasks[id];
    if (!record) {
      record = { id, status: 'pending', attempts: [], costUsd: 0, durationMs: 0 };
      this.record.tasks[id] = record;
    }
    return record;
  }

  setStatus(id: string, status: TaskStatus, extra: Partial<TaskRecord> = {}): void {
    const record = this.task(id);
    record.status = status;
    Object.assign(record, extra);
    this.flush();
  }

  addAttempt(id: string, attempt: AttemptRecord): void {
    const record = this.task(id);
    record.attempts.push(attempt);
    record.costUsd += attempt.agentCostUsd + attempt.reviewCostUsd;
    record.durationMs += attempt.durationMs;
    this.flush();
  }

  /** A task already finished by an earlier run of the same run id. */
  isDone(id: string): boolean {
    return this.record.tasks[id]?.status === 'done';
  }

  totalCostUsd(): number {
    return Object.values(this.record.tasks).reduce((sum, t) => sum + t.costUsd, 0);
  }

  counts(): Record<TaskStatus, number> {
    const counts: Record<TaskStatus, number> = {
      pending: 0,
      running: 0,
      done: 0,
      blocked: 0,
      skipped: 0,
    };
    for (const task of Object.values(this.record.tasks)) counts[task.status] += 1;
    return counts;
  }
}

/**
 * Read the current run record without claiming it.
 *
 * `StateStore` discards state belonging to a different run id, which is right
 * for writing and wrong for reading: `kalfa status` wants to report whatever
 * run last touched this repository, whichever it was.
 */
export function readRunRecord(cwd: string, stateDir = '.kalfa'): RunRecord | undefined {
  const path = join(cwd, stateDir, 'state.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
  } catch {
    return undefined;
  }
}

/** Stable, sortable, human-typable run id derived from the clock. */
export function makeRunId(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}
