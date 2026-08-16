import type { RunnerEvent } from '../runner/runner.js';
import { PHASE_LABEL, type ReviewFinding } from '../types.js';

/**
 * Turning the run's event stream into something a human reads.
 *
 * Three modes, one stream. The default answers "where is it now?" in a line
 * per transition; `--verbose` adds the commands, the builder's tool calls and
 * the gates' live output; `--jsonl` steps out of the way entirely and hands
 * the raw events to whatever is consuming them.
 *
 * Everything that gets shortened here names the file holding the long version.
 * A summary that cannot be checked is worse than no summary — a live run once
 * reported `review 2 blocking` and a truncated cause, and the operator had no
 * way to reach the reviewer's actual words.
 */

export interface RenderOptions {
  verbose: boolean;
  jsonl: boolean;
  write?: (text: string) => void;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const usd = (n: number): string => `$${n.toFixed(4)}`;

export function createRenderer(opts: RenderOptions): (event: RunnerEvent) => void {
  const write = opts.write ?? ((text: string): void => void process.stdout.write(text));

  if (opts.jsonl) {
    return (event: RunnerEvent): void => {
      // Raw subprocess output is a firehose and is already on disk under the
      // attempt directory; it is only in the stream at all for --verbose.
      if (event.type === 'output' && !opts.verbose) return;
      write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    };
  }

  return (event: RunnerEvent): void => {
    switch (event.type) {
      case 'run_start':
        write(`${event.total} tasks${event.branch ? ` on branch ${event.branch}` : ''}\n`);
        if (event.runDir) write(`artifacts in ${event.runDir}/\n`);
        write('\n');
        break;

      case 'task_start':
        write(`[${event.index + 1}/${event.total}] ${event.task.id}: ${event.task.title}\n`);
        break;

      case 'attempt_start':
        if (event.attempt > 1) write(`  retry ${event.attempt}/${event.max}\n`);
        break;

      case 'phase':
        // The line that was missing entirely: between "builder ok" and the
        // first gate result there used to be minutes of silence in which a
        // watcher could not tell work from a hang.
        write(`  · ${PHASE_LABEL[event.phase]}${event.detail ? ` — ${event.detail}` : ''}\n`);
        break;

      case 'command_start':
        // Gate commands print always: "gate project-check FAIL" is useless
        // without the command, and the operator's first move is to run it.
        // Agent command lines are long and only interesting under --verbose.
        if (event.phase === 'gate' || opts.verbose) {
          write(`    $ ${event.command}${event.pid ? `  [pid ${event.pid}]` : ''}\n`);
        }
        break;

      case 'command_end':
        if (opts.verbose && event.stdoutPath) write(`    output ${event.stdoutPath}\n`);
        break;

      case 'tool_event':
        if (opts.verbose) {
          write(`    ${event.tool.name}${event.tool.detail ? `  ${event.tool.detail}` : ''}\n`);
        }
        break;

      case 'output':
        if (opts.verbose) write(indent(event.chunk));
        break;

      case 'agent_done':
        write(
          `  builder  ${event.ok ? 'ok' : 'FAILED'}  ${seconds(event.durationMs)}` +
            `${event.costUsd > 0 ? `  ${usd(event.costUsd)}` : ''}` +
            `${event.toolCalls > 0 ? `  ${event.toolCalls} tool calls` : ''}\n`,
        );
        if (!event.ok && event.error) write(`           ${event.error.split('\n')[0]}\n`);
        // Said once, where it matters: silence from this provider is the CLI's
        // limitation and not evidence that the worker stalled.
        if (!event.toolEventsSupported && opts.verbose) {
          write(`           this provider reports no tool activity — see ${event.stdoutPath ?? 'its stdout artifact'}\n`);
        }
        break;

      case 'gates_done':
        for (const gate of event.results) {
          if (gate.skipped) continue;
          write(
            `  gate     ${gate.name.padEnd(10)} ${gate.ok ? 'pass' : 'FAIL'}  ${seconds(gate.durationMs)}` +
              `${!gate.ok && gate.stdoutPath ? `  ${gate.stdoutPath}` : ''}\n`,
          );
        }
        break;

      case 'worker_committed':
        write(`  ! the worker committed its own work — undone so the gates and reviewer can see it\n`);
        break;

      case 'retrying':
        write(`  cause    ${event.reason}\n`);
        if (event.causedBy) write(`           evidence ${event.causedBy}/\n`);
        break;

      case 'protected_touched':
        write(`  ! touched tests/checks: ${event.files.join(', ')} — flagged for review\n`);
        break;

      case 'second_opinion':
        write(`  review   blocking — asking once more before discarding the work\n`);
        break;

      case 'review_done':
        write(
          event.error
            ? `  review   ERROR  ${event.error.slice(0, 120)}${event.rawPath ? `\n           full response ${event.rawPath}` : ''}\n`
            : `  review   ${event.blocking > 0 ? `${event.blocking} blocking` : 'clean'}` +
              ` (${event.findings} finding${event.findings === 1 ? '' : 's'})` +
              `${event.findingsPath ? `  ${event.findingsPath}` : ''}\n`,
        );
        for (const finding of event.details ?? []) {
          write(renderFinding(finding, opts.verbose));
        }
        break;

      case 'task_done':
        if (event.status === 'done') {
          // On a resume this is the only line a finished task prints, so it has
          // to name the task: a column of bare "-> done" tells you nothing.
          write(`  -> ${event.taskId} done${event.commit ? ` ${event.commit.slice(0, 8)}` : ''}\n\n`);
        } else {
          write(`  -> ${event.status.toUpperCase()}: ${event.reason ?? ''}\n`);
          if (event.artifactsDir) write(`     evidence ${event.artifactsDir}/\n`);
          write('\n');
        }
        break;

      case 'run_end':
        break;
    }
  };
}

/**
 * A finding, at the length the mode allows.
 *
 * Truncating a reviewer's reasoning to one line is how a false blocker becomes
 * unanswerable, so `--verbose` prints it whole and the default says where the
 * whole thing is.
 */
function renderFinding(finding: ReviewFinding, verbose: boolean): string {
  const where = finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ''}` : '';
  const head = `           [${finding.severity}]${where} `;
  if (!verbose) {
    const summary = finding.summary.replace(/\s+/g, ' ');
    return `${head}${summary.length > 100 ? `${summary.slice(0, 100)}…` : summary}\n`;
  }
  const body = [finding.summary, finding.suggestion ? `suggested fix: ${finding.suggestion}` : '']
    .filter(Boolean)
    .join('\n');
  return `${head}\n${indent(body, '             ')}\n`;
}

function indent(text: string, prefix = '    | '): string {
  return text
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
    .concat('\n');
}
