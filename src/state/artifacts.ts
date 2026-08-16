import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRelative, runDir, STATE_DIR } from './dir.js';
import { Redactor } from './redact.js';

/**
 * Per-attempt evidence, at a path you can predict without reading any code:
 *
 *   .kalfa/runs/<run-id>/artifacts/<task>/<attempt>/
 *     builder.stdout.log      what the worker's CLI actually printed
 *     builder.stderr.log
 *     builder.prompt.md       opt-in: may contain repository content
 *     builder.tools.jsonl     tool/command activity, when the vendor reports it
 *     gates/<name>.stdout.log
 *     gates/<name>.stderr.log
 *     review.raw.txt          the reviewer's untruncated response
 *     review.findings.json    the parsed findings, all severities
 *     diff.patch / diff.stat.txt
 *     decision.json           what this attempt did next, and why
 *
 * The point is a stable answer to "where is the complete, untruncated
 * evidence?" — one that a terminal line, a journal event and a bug report can
 * all cite. Everything Kalfa's own summaries truncate is written here in full.
 *
 * Everything passes through the redactor on the way to disk.
 */
export class ArtifactStore {
  readonly dir: string;

  constructor(
    private readonly cwd: string,
    runId: string,
    private readonly redactor = new Redactor(),
    private readonly stateDir = STATE_DIR,
  ) {
    this.dir = runDir(cwd, runId, stateDir);
  }

  /** Absolute path of an attempt's directory, created on demand. */
  attemptDir(taskId: string, attempt: number): string {
    const dir = join(this.dir, 'artifacts', safe(taskId), String(attempt));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Absolute path for a named artifact, with its parent directory created. */
  path(taskId: string, attempt: number, ...parts: string[]): string {
    const full = join(this.attemptDir(taskId, attempt), ...parts.map(safe));
    mkdirSync(dirname(full), { recursive: true });
    return full;
  }

  /** Write an artifact and return its repo-relative path, for citing. */
  write(taskId: string, attempt: number, name: string, content: string): ArtifactRef {
    const full = this.path(taskId, attempt, ...name.split('/'));
    const { text, redacted } = this.redactor.redact(content);
    writeFileSync(full, text, 'utf8');
    return { path: this.rel(full), redacted };
  }

  writeJson(taskId: string, attempt: number, name: string, value: unknown): ArtifactRef {
    return this.write(taskId, attempt, name, `${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * An append-only sink for output that arrives in chunks.
   *
   * Streaming rather than buffering is the difference between having a
   * transcript and not: a builder that is killed, hangs, or takes the whole
   * process down with it still leaves everything it printed up to that moment
   * on disk. Redaction runs per chunk, which can miss a secret split across a
   * chunk boundary — an accepted trade for output that survives a crash.
   */
  sink(taskId: string, attempt: number, name: string): ArtifactSink {
    const full = this.path(taskId, attempt, ...name.split('/'));
    let fd: number | undefined;
    let redacted = false;
    let bytes = 0;

    return {
      path: this.rel(full),
      write: (chunk: string): void => {
        if (!chunk) return;
        const result = this.redactor.redact(chunk);
        redacted ||= result.redacted;
        const buffer = Buffer.from(result.text, 'utf8');
        bytes += buffer.byteLength;
        try {
          // Synchronous, deliberately. A buffered stream can lose its tail
          // when the process is killed, and the tail is the part an operator
          // wants — the last thing a hung builder printed before it stopped.
          // It also means anything tailing this file sees each chunk the
          // moment Kalfa did.
          fd ??= openSync(full, 'a');
          writeSync(fd, buffer);
        } catch {
          // An agent running loose in the repository can delete this file mid
          // run. Losing a transcript is not a reason to lose the run.
        }
      },
      close: (): ArtifactRef => {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // Already gone; nothing left to release.
          }
          fd = undefined;
        }
        return { path: this.rel(full), redacted, bytes };
      },
    };
  }

  rel(absolute: string): string {
    return repoRelative(this.cwd, absolute);
  }
}

export interface ArtifactRef {
  /** Repo-relative, forward slashes — safe to print and to paste. */
  path: string;
  redacted: boolean;
  bytes?: number;
}

export interface ArtifactSink {
  path: string;
  write: (chunk: string) => void;
  close: () => ArtifactRef;
}

/**
 * Keep task ids and gate names from escaping the run directory.
 *
 * Both come from files a human wrote — the plan and the config — but they
 * become filesystem paths here, and `..` in a task id must not be able to
 * write outside `.kalfa/`.
 */
function safe(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_') || '_';
}
