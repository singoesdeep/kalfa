import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../config/schema.js';
import type { AgentRun, ToolEvent } from '../types.js';

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
  /** The command line and pid, the moment the child exists. */
  onSpawn?: (info: { commandLine: string; pid?: number }) => void;
  /** Raw output as it arrives, for persisting and for `--verbose`. */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  /**
   * One tool call the agent made, when the vendor CLI reports them.
   *
   * This is the difference between "the builder has been running for nine
   * minutes" and "the builder is on its fourth `npm test`". Only the claude
   * provider can supply these today; see `toolEventsSupported`.
   */
  onToolEvent?: (event: ToolEvent) => void;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** Exactly what was spawned, so an operator can reproduce it by hand. */
  commandLine: string;
  pid?: number;
  /** ISO timestamp of the last byte the child produced, or undefined if none. */
  lastOutputAt?: string;
}

/**
 * Quote one argument for cmd.exe.
 *
 * Narrow by design: the arguments here are flags, model ids and paths that
 * Kalfa itself constructs. Windows forbids `"` in filenames, and none of the
 * flag values contain one, so wrapping in double quotes is sufficient. Prompts
 * never travel this way — they go on stdin precisely to avoid this problem.
 */
export function quoteForCmd(arg: string): string {
  return /[\s"^&|<>()%!]/.test(arg) ? `"${arg}"` : arg;
}

/** Thin promise wrapper over spawn, with a hard timeout and stdin prompt. */
export function runProcess(
  command: string,
  args: string[],
  input: string,
  opts: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Called per complete stdout line, for vendors that stream JSONL. */
    onLine?: (line: string) => void;
    onSpawn?: (info: { commandLine: string; pid?: number }) => void;
    onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // Windows needs a shell, because `claude` and `codex` are .cmd shims that
    // spawn cannot execute directly. But passing an args array WITH a shell
    // concatenates them unescaped — Node warns about it, and it is a real bug
    // here: the temp path handed to `--output-schema` contains the username,
    // so any user whose Windows account has a space in it would have had the
    // reviewer fail with a mangled path. Building the command line ourselves
    // puts the quoting under our control and silences the warning honestly,
    // rather than by suppressing it.
    const isWindows = process.platform === 'win32';
    const commandLine = [command, ...args.map(quoteForCmd)].join(' ');
    const child = isWindows
      ? spawn(commandLine, {
          cwd: opts.cwd,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : spawn(command, args, {
          cwd: opts.cwd,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

    opts.onSpawn?.({ commandLine, ...(child.pid !== undefined ? { pid: child.pid } : {}) });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let lastOutputAt: string | undefined;

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
      lastOutputAt = new Date().toISOString();
      opts.onOutput?.('stdout', text);
      if (!opts.onLine) return;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) opts.onLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      lastOutputAt = new Date().toISOString();
      opts.onOutput?.('stderr', text);
    });

    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) =>
      finish(() => {
        // A vendor that never terminates its last line would otherwise have it
        // dropped, taking the result object with it.
        if (opts.onLine && pending.trim()) opts.onLine(pending);
        resolve({
          stdout,
          stderr,
          code,
          timedOut,
          commandLine,
          ...(child.pid !== undefined ? { pid: child.pid } : {}),
          ...(lastOutputAt ? { lastOutputAt } : {}),
        });
      }),
    );

    child.stdin.on('error', () => {
      // A process that exits before reading stdin (bad flags, auth failure)
      // gives us EPIPE. The close handler reports the real reason.
    });
    child.stdin.end(input, 'utf8');
  });
}

function argsForClaude(agent: AgentConfig, systemPrompt?: string): string[] {
  // stream-json, not json.
  //
  // Both formats end with the same result object, so nothing downstream had to
  // change — but the streaming form emits one line per turn on the way there,
  // and those lines carry the tool calls. Without them a builder is a black box
  // for the length of a task: the operator cannot tell editing from testing
  // from stalled. `--verbose` is not optional here; claude requires it with
  // stream-json under `-p`.
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    agent.permission_mode,
  ];
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

export interface ClaudeResult {
  text: string;
  costUsd: number;
  sessionId?: string;
  /** SDK result subtype: 'success', 'error_max_turns', 'error_during_execution'. */
  subtype: string;
  /**
   * True when the run did not complete its work — including running out of
   * turns or context.
   *
   * This matters more than it looks. `claude -p` EXITS ZERO when it aborts
   * this way: the process ran fine, the task did not. Judging success by exit
   * code alone would mark a half-finished task complete, and if its gates
   * happened to pass, commit the partial work as done.
   */
  aborted: boolean;
}

/** `claude -p --output-format json` returns one object with usage and cost. */
export function parseClaudeResult(stdout: string): ClaudeResult {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: string;
      total_cost_usd?: number;
      session_id?: string;
      is_error?: boolean;
      subtype?: string;
    };
    const subtype = parsed.subtype ?? 'success';
    return {
      text: parsed.result ?? '',
      costUsd: parsed.total_cost_usd ?? 0,
      ...(parsed.session_id ? { sessionId: parsed.session_id } : {}),
      subtype,
      aborted: parsed.is_error === true || subtype !== 'success',
    };
  } catch {
    // Fall back to raw text rather than losing the worker's output entirely.
    return { text: stdout.trim(), costUsd: 0, subtype: 'unparseable', aborted: false };
  }
}

/**
 * Pull the tool calls out of one `--output-format stream-json` line.
 *
 * Deliberately shallow: the name, and one line describing what it was pointed
 * at. Kalfa does not record the tool's own output here — that is the vendor's
 * transcript to keep, it can be enormous, and it is the most likely place for
 * repository content to leak into an artifact.
 *
 * Nothing here records model reasoning. Thinking blocks are skipped.
 */
export function toolEventsFromLine(line: string): ToolEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const message = (parsed as { type?: string; message?: { content?: unknown } })?.message;
  if ((parsed as { type?: string }).type !== 'assistant' || !Array.isArray(message?.content)) {
    return [];
  }

  const at = new Date().toISOString();
  return (message.content as Array<Record<string, unknown>>)
    .filter((block) => block?.['type'] === 'tool_use' && typeof block['name'] === 'string')
    .map((block) => {
      const detail = describeToolInput(block['input']);
      return { at, name: block['name'] as string, ...(detail ? { detail } : {}) };
    });
}

/** One line describing what a tool call was aimed at, never its result. */
function describeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const fields = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description']) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) {
      const oneLine = value.replace(/\s+/g, ' ').trim();
      return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
    }
  }
  return undefined;
}

/**
 * The result object out of a stream-json transcript.
 *
 * The last `type: "result"` line is the same object the non-streaming format
 * returns whole, so the existing parser applies unchanged. When there is no
 * such line — an older CLI, a crash mid-stream — the raw output is parsed as
 * before rather than losing the run entirely.
 */
export function parseClaudeStream(stdout: string): ClaudeResult {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line?.startsWith('{')) continue;
    try {
      if ((JSON.parse(line) as { type?: string }).type === 'result') return parseClaudeResult(line);
    } catch {
      // Not the result line; keep walking backwards.
    }
  }
  return parseClaudeResult(stdout);
}

/** Turn an abort subtype into something the retry prompt can act on. */
export function describeAbort(subtype: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return (
        'the worker ran out of turns before finishing — its work is incomplete. ' +
        'Either the task is too large for one task, or max_turns is too low.'
      );
    case 'error_during_execution':
      return 'the worker hit an error partway through — its work is incomplete.';
    default:
      return `the worker ended with subtype "${subtype}" rather than completing.`;
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
      ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
      ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
      ...(opts.onToolEvent
        ? {
            onLine: (line: string): void => {
              for (const event of toolEventsFromLine(line)) opts.onToolEvent?.(event);
            },
          }
        : {}),
    });

    const parsed = parseClaudeStream(res.stdout);
    const durationMs = Date.now() - started;
    const ok = res.code === 0 && !res.timedOut && !parsed.aborted;

    const error = res.timedOut
      ? `timed out after ${this.agent.timeout_ms}ms`
      : parsed.aborted
        ? describeAbort(parsed.subtype)
        : `claude exited ${res.code}: ${res.stderr.trim().slice(-2000)}`;

    return {
      text: parsed.text,
      ok,
      costUsd: parsed.costUsd,
      costKnown: true,
      durationMs,
      toolEventsSupported: true,
      commandLine: res.commandLine,
      ...(res.pid !== undefined ? { pid: res.pid } : {}),
      ...(res.lastOutputAt ? { lastOutputAt: res.lastOutputAt } : {}),
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      ...(ok ? {} : { error }),
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
        ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
        ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
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
        // Codex does not report per-run cost on stdout. Reporting 0 with
        // costKnown false keeps the total honest as a floor; inventing a
        // number from a local price table would be worse than admitting it.
        costUsd: 0,
        costKnown: false,
        durationMs: Date.now() - started,
        // `codex exec` reports no per-turn tool activity on stdout. Said
        // plainly rather than left as silence: an operator watching a reviewer
        // print nothing for four minutes should know that is the CLI, not a
        // hang, and the stdout artifact plus the pid are what they get instead.
        toolEventsSupported: false,
        commandLine: res.commandLine,
        ...(res.pid !== undefined ? { pid: res.pid } : {}),
        ...(res.lastOutputAt ? { lastOutputAt: res.lastOutputAt } : {}),
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
