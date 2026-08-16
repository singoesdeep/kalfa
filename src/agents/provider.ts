import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../config/schema.js';
import type { AgentRun } from '../types.js';

/**
 * Both agents are driven as subprocesses rather than through an SDK.
 *
 * That is a deliberate trade: we give up streaming granularity and get a
 * uniform interface across vendors, no SDK version coupling, and reuse of
 * whatever credentials the user's CLIs already hold. Adding a third provider
 * means adding a case here, not a new dependency.
 *
 * Prompts always travel on stdin. Passing a multi-thousand-character prompt
 * through argv is a quoting minefield, doubly so on Windows where these
 * binaries are .cmd shims that require `shell: true`.
 */

export interface InvokeOptions {
  cwd: string;
  /** Appended after Kalfa's autonomy contract. */
  systemPrompt?: string;
  /** Forces JSON output conforming to this schema. Codex only. */
  outputSchema?: unknown;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Thin promise wrapper over spawn, with a hard timeout and stdin prompt. */
export function runProcess(
  command: string,
  args: string[],
  input: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; onLine?: (line: string) => void },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      // .cmd shims on Windows are not directly executable.
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (!opts.onLine) return;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) opts.onLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, code, timedOut })));

    child.stdin.on('error', () => {
      // A process that exits before reading stdin (bad flags, auth failure)
      // gives us EPIPE. The close handler reports the real reason.
    });
    child.stdin.end(input, 'utf8');
  });
}

function argsForClaude(agent: AgentConfig, systemPrompt?: string): string[] {
  const args = ['-p', '--output-format', 'json', '--permission-mode', agent.permission_mode];
  if (agent.model) args.push('--model', agent.model);
  if (agent.max_turns !== undefined) args.push('--max-turns', String(agent.max_turns));
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (agent.allowed_tools?.length) args.push('--allowed-tools', ...agent.allowed_tools);
  if (agent.disallowed_tools?.length) args.push('--disallowed-tools', ...agent.disallowed_tools);
  for (const dir of agent.add_dirs) args.push('--add-dir', dir);
  if (agent.permission_mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  return args;
}

function argsForCodex(agent: AgentConfig, schemaPath?: string): string[] {
  // `-` makes codex read the prompt from stdin.
  const args = ['exec', '-', '--sandbox', agent.sandbox, '--skip-git-repo-check'];
  if (agent.model) args.push('--model', agent.model);
  if (schemaPath) args.push('--output-schema', schemaPath);
  for (const dir of agent.add_dirs) args.push('--add-dir', dir);
  return args;
}

/** `claude -p --output-format json` returns one object with usage and cost. */
function parseClaudeResult(stdout: string): { text: string; costUsd: number; sessionId?: string } {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: string;
      total_cost_usd?: number;
      session_id?: string;
      is_error?: boolean;
    };
    return {
      text: parsed.result ?? '',
      costUsd: parsed.total_cost_usd ?? 0,
      ...(parsed.session_id ? { sessionId: parsed.session_id } : {}),
    };
  } catch {
    // Fall back to raw text rather than losing the worker's output entirely.
    return { text: stdout.trim(), costUsd: 0 };
  }
}

export class AgentInvoker {
  constructor(private readonly agent: AgentConfig) {}

  get provider(): string {
    return this.agent.provider;
  }

  get label(): string {
    return this.agent.model ? `${this.agent.provider}:${this.agent.model}` : this.agent.provider;
  }

  async invoke(prompt: string, opts: InvokeOptions): Promise<AgentRun> {
    const started = Date.now();
    return this.agent.provider === 'claude'
      ? this.invokeClaude(prompt, opts, started)
      : this.invokeCodex(prompt, opts, started);
  }

  private async invokeClaude(
    prompt: string,
    opts: InvokeOptions,
    started: number,
  ): Promise<AgentRun> {
    const args = argsForClaude(this.agent, opts.systemPrompt);
    const res = await runProcess('claude', args, prompt, {
      cwd: opts.cwd,
      timeoutMs: this.agent.timeout_ms,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    const parsed = parseClaudeResult(res.stdout);
    const durationMs = Date.now() - started;
    const ok = res.code === 0 && !res.timedOut;

    return {
      text: parsed.text,
      ok,
      costUsd: parsed.costUsd,
      durationMs,
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      ...(ok
        ? {}
        : {
            error: res.timedOut
              ? `timed out after ${this.agent.timeout_ms}ms`
              : `claude exited ${res.code}: ${res.stderr.trim().slice(-2000)}`,
          }),
    };
  }

  private async invokeCodex(
    prompt: string,
    opts: InvokeOptions,
    started: number,
  ): Promise<AgentRun> {
    // --output-schema and --output-last-message both want real files.
    const dir = mkdtempSync(join(tmpdir(), 'kalfa-'));
    const lastMessagePath = join(dir, 'last-message.txt');
    let schemaPath: string | undefined;
    if (opts.outputSchema) {
      schemaPath = join(dir, 'schema.json');
      writeFileSync(schemaPath, JSON.stringify(opts.outputSchema, null, 2), 'utf8');
    }

    try {
      const args = argsForCodex(this.agent, schemaPath);
      args.push('--output-last-message', lastMessagePath);
      // Codex has no --append-system-prompt; the contract rides in the prompt.
      const fullPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n---\n\n${prompt}` : prompt;

      const res = await runProcess('codex', args, fullPrompt, {
        cwd: opts.cwd,
        timeoutMs: this.agent.timeout_ms,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      let text = '';
      try {
        text = readFileSync(lastMessagePath, 'utf8').trim();
      } catch {
        text = res.stdout.trim();
      }

      const ok = res.code === 0 && !res.timedOut;
      return {
        text,
        ok,
        // Codex does not report per-run cost on stdout; leave it honest at 0
        // rather than inventing a number from a local price table.
        costUsd: 0,
        durationMs: Date.now() - started,
        ...(ok
          ? {}
          : {
              error: res.timedOut
                ? `timed out after ${this.agent.timeout_ms}ms`
                : `codex exited ${res.code}: ${res.stderr.trim().slice(-2000)}`,
            }),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
