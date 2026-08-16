import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir } from '../state/dir.js';
import { Redactor } from '../state/redact.js';
import type { Phase } from '../types.js';

/**
 * The morning report.
 *
 * Kalfa's whole bargain is that you trade synchronous approval for
 * asynchronous review. That only works if what happened overnight is legible
 * in five minutes. Three artifacts, each with one job:
 *
 *   docs/adr/         — every decision the worker made instead of asking you
 *   BLOCKED.md        — what it refused to do, and why
 *   .kalfa/journal.jsonl — the machine-readable event log
 */

export interface JournalEvent {
  at: string;
  runId: string;
  type: string;
  taskId?: string;
  /** Present on everything inside a task attempt. */
  attempt?: number;
  /** Which stage of the attempt produced this event. */
  phase?: Phase;
  [key: string]: unknown;
}

export class Journal {
  private readonly journalPath: string;

  constructor(
    private readonly cwd: string,
    private readonly runId: string,
    stateDir = '.kalfa',
    private readonly redactor = new Redactor(),
  ) {
    this.journalPath = join(ensureStateDir(cwd, stateDir), 'journal.jsonl');
  }

  /** Where the stream lives, so a run can tell an operator what to follow. */
  get path(): string {
    return this.journalPath;
  }

  event(type: string, fields: Record<string, unknown> = {}): void {
    const event: JournalEvent = {
      at: new Date().toISOString(),
      runId: this.runId,
      type,
      ...fields,
    };
    // Redacting the serialized line rather than each field is both simpler and
    // more complete: it cannot miss a secret nested three objects deep in a
    // gate result. JSON escaping does not change the shape of the credentials
    // being matched, so the patterns still hit.
    const line = this.redactor.redact(JSON.stringify(event)).text;
    appendFileSync(this.journalPath, `${line}\n`, 'utf8');
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
    appendFileSync(path, this.redactor.redact(entry).text, 'utf8');
  }
}
