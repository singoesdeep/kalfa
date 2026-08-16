import { openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../plan/schema.js';
import type { JournalEvent } from '../journal/journal.js';
import { readRunRecord } from '../state/store.js';
import { isProcessAlive, readLock } from '../state/lock.js';
import { renderBoardPlain } from '../board/board.js';
import { PHASE_LABEL, type Phase, type RunRecord } from '../types.js';

/**
 * Following a run that is happening somewhere else.
 *
 * `kalfa status` answers "where is it now?" once. It does not answer the other
 * half of the unattended bargain — "how will I know when it needs me?" — and
 * an operator away from the terminal was left polling by hand, unable to tell
 * a run that was working from one that had blocked an hour ago.
 *
 * This watches `.kalfa/journal.jsonl`, the same append-only stream the run
 * writes as it goes, and exits when the run reaches a terminal state. It makes
 * no API calls and spends nothing: it reads local files and sleeps.
 *
 * Exit codes, which are the point of it — a script can branch on these:
 *
 *   0  the run finished and every task is done
 *   2  the run finished with blocked or skipped tasks
 *   3  the run stopped without finishing (killed, crashed, machine rebooted)
 *   1  there was nothing to watch
 */

export const WATCH_EXIT = {
  clean: 0,
  nothingToWatch: 1,
  needsYou: 2,
  died: 3,
} as const;

export interface WatchOptions {
  cwd: string;
  plan?: Plan;
  /** Emit the raw journal events instead of prose. */
  json: boolean;
  /** A TTY gets the board redrawn; a pipe gets one line per transition. */
  tty: boolean;
  pollMs?: number;
  write?: (text: string) => void;
  signal?: AbortSignal;
  /** Injection seam for tests; real sleeping otherwise. */
  sleep?: (ms: number) => Promise<void>;
  stateDir?: string;
}

export async function watchRun(opts: WatchOptions): Promise<number> {
  const write = opts.write ?? ((text: string): void => void process.stdout.write(text));
  const sleep =
    opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.()));
  const pollMs = opts.pollMs ?? 1000;
  const stateDir = opts.stateDir ?? '.kalfa';

  const initial = readRunRecord(opts.cwd, stateDir);
  if (!initial) {
    write('kalfa: no run state found — nothing has been run in this repository yet\n');
    return WATCH_EXIT.nothingToWatch;
  }

  const runId = initial.runId;
  const journalPath = join(opts.cwd, stateDir, 'journal.jsonl');
  const reader = new JournalTail(journalPath);
  const printer = new TransitionPrinter(write, opts, runId);

  // Catch up first. Starting from the end would be wrong: the whole reason to
  // attach to a running build is to find out where it got to, and half of that
  // answer is already in the file.
  for (const event of reader.read()) {
    if (event.runId === runId) printer.catchUp(event);
  }
  printer.endCatchUp(initial);

  for (;;) {
    if (opts.signal?.aborted) return WATCH_EXIT.nothingToWatch;

    for (const event of reader.read()) {
      if (event.runId === runId) printer.live(event);
    }

    const record = readRunRecord(opts.cwd, stateDir) ?? initial;
    if (printer.sawRunEnd || record.finishedAt) {
      return report(write, opts, record);
    }
    // A run that is neither finished nor holding its lock is gone: killed,
    // crashed, or the machine rebooted under it. Waiting forever for an event
    // that will never arrive is the one failure mode a watcher must not have.
    if (!isRunAlive(opts.cwd, stateDir, runId)) {
      write(`\nrun ${runId} is no longer running and never finished.\n`);
      write(`resume it with: kalfa run --run-id ${runId}\n`);
      return WATCH_EXIT.died;
    }

    await sleep(pollMs);
  }
}

function isRunAlive(cwd: string, stateDir: string, runId: string): boolean {
  const lock = readLock(cwd, stateDir);
  if (!lock || lock.runId !== runId) return false;
  return isProcessAlive(lock.pid);
}

function report(write: (text: string) => void, opts: WatchOptions, record: RunRecord): number {
  const counts = { done: 0, blocked: 0, skipped: 0, running: 0, pending: 0 };
  for (const task of Object.values(record.tasks)) counts[task.status] += 1;

  if (opts.plan && !opts.json) {
    write(`\n${renderBoardPlain(opts.plan, record)}\n`);
  }
  if (!opts.json) {
    const cost = Object.values(record.tasks).reduce((sum, t) => sum + t.costUsd, 0);
    write(
      `\nrun ${record.runId} finished — ${counts.done} done, ${counts.blocked} blocked, ` +
        `${counts.skipped} skipped  ·  $${cost.toFixed(4)}${record.costIncomplete ? '+' : ''}\n`,
    );
    if (record.stoppedEarly) write(`stopped early: ${record.stoppedEarly}\n`);
    if (counts.blocked + counts.skipped > 0) write(`read BLOCKED.md for what needs you\n`);
  }

  return counts.blocked + counts.skipped > 0 ? WATCH_EXIT.needsYou : WATCH_EXIT.clean;
}

/**
 * Read whatever has been appended since last time.
 *
 * By byte offset rather than by watching the file: `fs.watch` semantics differ
 * enough across platforms and network filesystems that a missed notification
 * would silently stall the watcher, and the file is append-only, so an offset
 * is both correct and cheap. A file that shrank was rotated or replaced, and
 * is re-read from the start.
 */
export class JournalTail {
  private offset = 0;
  private partial = '';

  constructor(private readonly path: string) {}

  read(): JournalEvent[] {
    if (!existsSync(this.path)) return [];

    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return [];

    const length = size - this.offset;
    const buffer = Buffer.allocUnsafe(length);
    const fd = openSync(this.path, 'r');
    try {
      const bytes = readSync(fd, buffer, 0, length, this.offset);
      this.offset += bytes;
      this.partial += buffer.subarray(0, bytes).toString('utf8');
    } finally {
      closeSync(fd);
    }

    const lines = this.partial.split('\n');
    // A run appending as we read leaves the last line half-written; hold it
    // back rather than dropping the event it will become.
    this.partial = lines.pop() ?? '';

    return lines.flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as JournalEvent];
      } catch {
        return [];
      }
    });
  }
}

/**
 * One line per thing that changed.
 *
 * Not a board redrawn on a timer: a pipe, a CI log or a file being tailed
 * wants transitions, and dumping the whole board every second makes the one
 * line that mattered impossible to find. A TTY gets the board once, at the
 * end, when it is worth reading.
 */
class TransitionPrinter {
  sawRunEnd = false;
  private caughtUp: JournalEvent[] = [];

  constructor(
    private readonly write: (text: string) => void,
    private readonly opts: WatchOptions,
    private readonly runId: string,
  ) {}

  catchUp(event: JournalEvent): void {
    if (event.type === 'run_end') this.sawRunEnd = true;
    this.caughtUp.push(event);
  }

  /** Summarise the backlog, then start printing live. */
  endCatchUp(record: RunRecord): void {
    if (this.opts.json) {
      for (const event of this.caughtUp) this.write(`${JSON.stringify(event)}\n`);
      this.caughtUp = [];
      return;
    }

    const done = Object.values(record.tasks).filter((t) => t.status === 'done').length;
    const total = Object.keys(record.tasks).length;
    this.write(`watching run ${this.runId}${record.branch ? ` on ${record.branch}` : ''}\n`);
    if (this.caughtUp.length > 0) {
      this.write(`${this.caughtUp.length} events so far, ${done}/${total || '?'} tasks done\n`);
      // The tail of the backlog, so an operator attaching mid-run sees where
      // it actually is rather than only what happens next.
      for (const event of this.caughtUp.slice(-5)) {
        const line = describe(event);
        if (line) this.write(`  ${line}\n`);
      }
    }
    this.write('\n');
    this.caughtUp = [];
  }

  live(event: JournalEvent): void {
    if (event.type === 'run_end') this.sawRunEnd = true;
    if (this.opts.json) {
      this.write(`${JSON.stringify(event)}\n`);
      return;
    }
    const line = describe(event);
    if (line) this.write(`${event.at.slice(11, 19)}  ${line}\n`);
  }
}

/** One line for an event, or nothing when it adds no information. */
export function describe(event: JournalEvent): string | undefined {
  const where = event.taskId
    ? `${event.taskId}${event.attempt ? `/${String(event.attempt)}` : ''}`
    : '';
  const field = (name: string): string | undefined => {
    const value = event[name];
    return typeof value === 'string' ? value : undefined;
  };

  switch (event.type) {
    case 'run_start':
      return `run started — ${String(event['total'] ?? '?')} tasks${event['branch'] ? ` on ${String(event['branch'])}` : ''}`;
    case 'task_start':
      return `${where} start — ${field('title') ?? ''}`;
    case 'attempt_start':
      return `${where} attempt ${String(event.attempt ?? 1)}`;
    case 'phase':
      return `${where} ${PHASE_LABEL[event.phase as Phase] ?? String(event.phase)}${
        field('detail') ? ` — ${field('detail')}` : ''
      }`;
    case 'command_started':
      return `${where} $ ${field('command') ?? field('name') ?? ''}`;
    case 'command_finished':
      return `${where} ${field('name') ?? ''} ${event['ok'] ? 'ok' : 'FAILED'}`;
    case 'agent_done':
      return `${where} builder ${event['ok'] ? 'ok' : 'FAILED'}`;
    case 'gates_done': {
      const results = (event['results'] as Array<{ name: string; ok: boolean; skipped?: boolean }>) ?? [];
      const failed = results.filter((g) => !g.ok && !g.skipped).map((g) => g.name);
      return `${where} gates ${failed.length === 0 ? 'pass' : `FAIL — ${failed.join(', ')}`}`;
    }
    case 'review_done':
      return `${where} review ${
        field('error') ? `ERROR ${field('error')?.slice(0, 80)}` : `${String(event['blocking'] ?? 0)} blocking`
      }`;
    case 'retry_decision':
      return `${where} retrying${event['causedBy'] ? ` — evidence ${String(event['causedBy'])}/` : ''}`;
    case 'task_done':
      return `${where} DONE${event['commit'] ? ` ${String(event['commit']).slice(0, 8)}` : ''}`;
    case 'task_blocked':
      return `${where} BLOCKED — ${field('reason') ?? ''}`;
    case 'task_skipped':
      return `${where} SKIPPED — ${field('reason') ?? ''}`;
    case 'run_end':
      return 'run finished';
    default:
      return undefined;
  }
}
