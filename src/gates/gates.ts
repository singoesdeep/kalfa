import { spawn } from 'node:child_process';
import type { GateConfig } from '../config/schema.js';
import type { GateResult } from '../types.js';

/**
 * Gates are the thing that replaces your approval. They must be cheap,
 * deterministic and non-interactive: a gate that opens a pager or waits on
 * stdin will hang the run until its timeout.
 */

/**
 * How a caller watches a gate run.
 *
 * Gate output used to exist in exactly one form: a trimmed tail, merged across
 * both streams, buried in the state file. That is enough to feed a retry and
 * not enough to diagnose one. The runner now hands in sinks that keep the full
 * streams separately on disk, and an `onOutput` for `--verbose`, so a gate that
 * takes six minutes is visibly doing something.
 */
export interface GateObserver {
  /** Called with the exact command, immediately before it is spawned. */
  onStart?: (gate: GateConfig) => void;
  /** Live output, stream-tagged. Called per chunk, not per line. */
  onOutput?: (gate: GateConfig, stream: 'stdout' | 'stderr', chunk: string) => void;
  /** Where to persist the untruncated streams for this gate. */
  sinks?: (gate: GateConfig) => GateSinks | undefined;
  onFinish?: (result: GateResult) => void;
}

export interface GateSinks {
  stdout: { path: string; write: (chunk: string) => void; close: () => unknown };
  stderr: { path: string; write: (chunk: string) => void; close: () => unknown };
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CI: '1',
        // Keep tools from emitting colour codes into the agent's feedback.
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    });

    let output = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const take = (stream: 'stdout' | 'stderr') => (c: Buffer) => {
      const text = c.toString('utf8');
      // The merged copy is what the agent reads back on failure; interleaving
      // the two streams in arrival order is how a human would have read them
      // in a terminal, and how a compiler's error lines line up with its
      // progress lines.
      output += text;
      onChunk?.(stream, text);
    };

    child.stdout.on('data', take('stdout'));
    child.stderr.on('data', take('stderr'));
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => resolve({ code, output, timedOut })));
  });
}

/**
 * Keep the tail, not the head: compilers and test runners put the summary and
 * the failing cases at the end, and the head is usually boilerplate.
 */
export function trimOutput(output: string, maxChars: number): string {
  const text = output.trim();
  if (text.length <= maxChars) return text;
  return `[... ${text.length - maxChars} characters trimmed ...]\n${text.slice(-maxChars)}`;
}

export async function runGate(
  gate: GateConfig,
  cwd: string,
  signal?: AbortSignal,
  observer?: GateObserver,
): Promise<GateResult> {
  const started = Date.now();
  const sinks = observer?.sinks?.(gate);
  observer?.onStart?.(gate);

  const paths = sinks ? { stdoutPath: sinks.stdout.path, stderrPath: sinks.stderr.path } : {};

  const finish = (result: GateResult): GateResult => {
    sinks?.stdout.close();
    sinks?.stderr.close();
    observer?.onFinish?.(result);
    return result;
  };

  try {
    const res = await runShell(gate.run, cwd, gate.timeout_ms, signal, (stream, chunk) => {
      (stream === 'stdout' ? sinks?.stdout : sinks?.stderr)?.write(chunk);
      observer?.onOutput?.(gate, stream, chunk);
    });
    const output = res.timedOut
      ? `Gate "${gate.name}" timed out after ${gate.timeout_ms}ms.\n${res.output}`
      : res.output;
    const trimmed = trimOutput(output, gate.max_output_chars);
    return finish({
      name: gate.name,
      ok: res.code === 0 && !res.timedOut,
      exitCode: res.code ?? -1,
      output: trimmed,
      durationMs: Date.now() - started,
      command: gate.run,
      ...paths,
      ...(trimmed.length < output.trim().length ? { truncated: true } : {}),
    });
  } catch (err) {
    return finish({
      name: gate.name,
      ok: false,
      exitCode: -1,
      output: `Gate "${gate.name}" could not be started: ${(err as Error).message}`,
      durationMs: Date.now() - started,
      command: gate.run,
      ...paths,
    });
  }
}

/**
 * Run gates in declaration order, stopping at the first required failure.
 * A type error makes the test output noise, and the agent is better served by
 * one real error than by a cascade.
 */
export async function runGates(
  gates: GateConfig[],
  cwd: string,
  signal?: AbortSignal,
  observer?: GateObserver,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  let halted = false;

  for (const gate of gates) {
    if (halted) {
      results.push({
        name: gate.name,
        ok: false,
        exitCode: -1,
        output: '',
        durationMs: 0,
        skipped: true,
        command: gate.run,
      });
      continue;
    }
    const result = await runGate(gate, cwd, signal, observer);
    results.push(result);
    if (!result.ok && gate.required) halted = true;
  }

  return results;
}

/** Gates that failed and are allowed to force a retry. */
export function blockingFailures(results: GateResult[], gates: GateConfig[]): GateResult[] {
  const required = new Map(gates.map((g) => [g.name, g.required]));
  return results.filter((r) => !r.ok && !r.skipped && required.get(r.name) !== false);
}

/** Select the gates a task asked for, preserving config order. */
export function gatesForTask(all: GateConfig[], names?: string[]): GateConfig[] {
  if (!names) return all;
  const wanted = new Set(names);
  return all.filter((g) => wanted.has(g.name));
}
