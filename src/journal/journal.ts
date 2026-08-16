import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir } from '../state/dir.js';

/**
 * The morning report.
 *
 * Kalfa's whole bargain is that you trade synchronous approval for
 * asynchronous review. That only works if what happened overnight is legible
 * in five minutes. Three artifacts, each with one job:
 *
 *   DECISIONS.md      — every assumption the worker made instead of asking you
 *   BLOCKED.md        — what it refused to do, and why
 *   .kalfa/journal.jsonl — the machine-readable event log
 */

export interface JournalEvent {
  at: string;
  runId: string;
  type: string;
  taskId?: string;
  [key: string]: unknown;
}

export class Journal {
  private readonly journalPath: string;

  constructor(
    private readonly cwd: string,
    private readonly runId: string,
    stateDir = '.kalfa',
  ) {
    this.journalPath = join(ensureStateDir(cwd, stateDir), 'journal.jsonl');
  }

  event(type: string, fields: Record<string, unknown> = {}): void {
    const event: JournalEvent = {
      at: new Date().toISOString(),
      runId: this.runId,
      type,
      ...fields,
    };
    appendFileSync(this.journalPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  /** Read back this run's events, for `kalfa report`. */
  read(): JournalEvent[] {
    if (!existsSync(this.journalPath)) return [];
    return readFileSync(this.journalPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as JournalEvent];
        } catch {
          return [];
        }
      });
  }

  /**
   * Kalfa appends the header; the worker appends its own entries per the
   * autonomy contract. Seeding the file means the worker never has to decide
   * where to put the first one.
   */
  ensureDecisionLog(): void {
    const path = join(this.cwd, 'DECISIONS.md');
    if (existsSync(path)) return;
    writeFileSync(
      path,
      [
        '# Decisions',
        '',
        'Assumptions Kalfa made instead of stopping to ask. Read these first —',
        'each one is a question you would otherwise have been woken up for.',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  /** Kalfa's own blocked entry. Workers append here too, per the contract. */
  recordBlocked(taskId: string, title: string, reason: string, detail?: string): void {
    const path = join(this.cwd, 'BLOCKED.md');
    if (!existsSync(path)) {
      writeFileSync(
        path,
        ['# Blocked', '', 'Tasks Kalfa would not finish on its own. These need you.', ''].join('\n'),
        'utf8',
      );
    }
    const entry = [
      '',
      `## ${taskId}: ${title}`,
      `- **When:** ${new Date().toISOString()}`,
      `- **Reason:** ${reason}`,
      ...(detail ? ['', '```', detail.slice(0, 4000), '```'] : []),
      '',
    ].join('\n');
    appendFileSync(path, entry, 'utf8');
  }
}
