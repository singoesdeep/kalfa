import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import * as git from '../git/git.js';
import { quoteForCmd } from '../agents/provider.js';
import { ConfigError, loadConfig, loadPlan } from '../config/load.js';
import type { GateConfig, KalfaConfig, Provider } from '../config/schema.js';
import type { Plan } from '../plan/schema.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  /** Stable machine identifier, e.g. 'git-clean', 'gate:typecheck'. */
  id: string;
  /** Human label for the report's second column, e.g. 'clean tree'. */
  label: string;
  status: CheckStatus;
  /** One-line explanation. Empty string when there is nothing to add. */
  detail: string;
  /** Extra indented lines: git status entries, config summary facts. */
  lines?: string[];
  /** What the operator should do. Present on every 'fail'; optional otherwise. */
  remedy?: string;
}

export interface DoctorReport {
  /** True when no check has status 'fail'. Drives the exit code. */
  ok: boolean;
  checks: Check[];
  counts: { ok: number; warn: number; fail: number; skip: number };
}

export interface DoctorOptions {
  cwd: string;
  configPath?: string;
  planPath?: string;
  probe?: (binary: string) => Promise<ProbeResult>;
}

export interface ProbeResult {
  found: boolean;
  version?: string;
  error?: string;
}

const HEAD_TOKEN_TERMINATORS = [' ', '\t', ';', '|', '&', '>', '<', '\n'];
const UNRESOLVABLE_TOKEN_CHARS = ['$', '`', '(', '='];

export function headToken(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed === '') return undefined;

  let end = trimmed.length;
  for (const terminator of HEAD_TOKEN_TERMINATORS) {
    const idx = trimmed.indexOf(terminator);
    if (idx !== -1 && idx < end) end = idx;
  }
  const token = trimmed.slice(0, end);

  if (token.startsWith('"') || token.startsWith("'")) return undefined;
  if (UNRESOLVABLE_TOKEN_CHARS.some((c) => token.includes(c))) return undefined;

  return token;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function isExistingFile(path: string): boolean {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat !== undefined && stat.isFile();
}

export function resolveExecutable(token: string, cwd: string): string | undefined {
  if (token.includes('/') || token.includes('\\')) {
    const candidate = resolve(cwd, token);
    return isExistingFile(candidate) ? candidate : undefined;
  }

  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter((d) => d !== '');

  for (const dir of pathDirs) {
    const absDir = resolve(cwd, dir);
    if (process.platform === 'win32') {
      const bare = join(absDir, token);
      if (isExistingFile(bare)) return bare;

      const pathext = (process.env.PATHEXT ?? DEFAULT_PATHEXT)
        .split(';')
        .filter((e) => e !== '');
      for (const ext of pathext) {
        const withExt = join(absDir, token + ext);
        if (isExistingFile(withExt)) return withExt;
      }
    } else {
      const candidate = join(absDir, token);
      if (isExistingFile(candidate)) return candidate;
    }
  }

  return undefined;
}

const PROBE_TIMEOUT_MS = 10000;

/** Runs `<binary> --version` with a hard timeout. Never rejects. */
export function probeCli(binary: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let child;
    try {
      // Same shape as the agent invoker: Windows needs a shell for the .cmd
      // shims, and passing an args array alongside a shell concatenates them
      // unescaped. Build the command line instead of letting the shell guess.
      child =
        process.platform === 'win32'
          ? spawn([quoteForCmd(binary), '--version'].join(' '), {
              shell: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            })
          : spawn(binary, ['--version'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      // Synchronous spawn failures (e.g. invalid binary name, embedded
      // null bytes) never reach the child's `error` handler.
      resolve({ found: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, PROBE_TIMEOUT_MS);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', () => {
      // ENOENT (missing binary) and any other spawn error are equally
      // "not usable" from the operator's point of view.
      finish(() => resolve({ found: false }));
    });

    child.on('close', (code) => {
      finish(() => {
        if (timedOut) {
          resolve({ found: true, error: `timed out after ${PROBE_TIMEOUT_MS}ms` });
          return;
        }

        if (code === 0) {
          const line = stdout
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l !== '');
          const v = line?.slice(0, 80);
          resolve({ found: true, ...(v ? { version: v } : {}) });
          return;
        }

        // On Windows, `shell: true` means a missing binary doesn't ENOENT —
        // the shell itself exits non-zero having written nothing to stdout.
        if (process.platform === 'win32' && stdout.trim() === '') {
          resolve({ found: false });
          return;
        }

        const trimmedStderr = stderr.trim();
        const error =
          `\`${binary} --version\` exited ${code}` +
          (trimmedStderr ? `: ${trimmedStderr.slice(-200)}` : '');
        resolve({ found: true, error });
      });
    });

    child.stdin.on('error', () => {
      // A process that exits before reading stdin gives us EPIPE; the
      // close handler reports the real reason.
    });
    child.stdin.end('', 'utf8');
  });
}

/**
 * Runs `fn` and turns any exception into a `fail` check instead of letting it
 * escape. This is what keeps one broken check from taking the rest of the
 * report down with it.
 */
function guard(id: string, label: string, fn: () => Check): Check {
  try {
    return fn();
  } catch (err) {
    return { id, label, status: 'fail', detail: `check errored: ${(err as Error).message}` };
  }
}

/** Same as {@link guard}, for checks that can emit more than one entry. */
function guardMany(id: string, label: string, fn: () => Check[]): Check[] {
  try {
    return fn();
  } catch (err) {
    return [{ id, label, status: 'fail', detail: `check errored: ${(err as Error).message}` }];
  }
}

/** Never rejects — a probe rejection becomes a value the classifier can guard against. */
async function safeProbe(
  binary: string,
  probe: (b: string) => Promise<ProbeResult>,
): Promise<ProbeResult | Error> {
  try {
    return await probe(binary);
  } catch (err) {
    return err as Error;
  }
}

function requiredProviders(config: KalfaConfig): Set<Provider> {
  const set = new Set<Provider>();
  set.add(config.agents.builder.provider);
  if (config.agents.reviewer) set.add(config.agents.reviewer.provider);
  return set;
}

function classifyProbe(
  n: Provider,
  result: ProbeResult,
  requiredSet: Set<Provider> | undefined,
): Pick<Check, 'status' | 'detail' | 'remedy'> {
  if (result.found && result.version) {
    return { status: 'ok', detail: result.version };
  }
  if (result.found && !result.error) {
    return { status: 'ok', detail: 'found on PATH' };
  }

  const detail = result.found ? (result.error ?? '') : 'not found on PATH';
  const remedy = result.found
    ? 'the binary is on PATH but did not answer a version probe; check the install'
    : `install the ${n} CLI and put it on PATH — see the Requirements section of the README`;

  const known = requiredSet !== undefined;
  const required = known && requiredSet.has(n);
  if (known && required) return { status: 'fail', detail, remedy };
  if (known && !required) return { status: 'warn', detail: `${detail} (not used by this config)`, remedy };
  return { status: 'warn', detail, remedy };
}

/** Reproduces, verbatim in wording, the advisory warnings `kalfa validate` emits. */
function buildConfigAgentsChecks(config: KalfaConfig): Check[] {
  const findings: Check[] = [];
  const builder = config.agents.builder;

  if (
    builder.provider === 'claude' &&
    builder.permission_mode === 'acceptEdits' &&
    !builder.allowed_tools?.some((t) => t.startsWith('Bash'))
  ) {
    findings.push({
      id: 'config-agents:permission-mode',
      label: 'agents',
      status: 'warn',
      detail: 'builder uses permission_mode acceptEdits, which auto-approves edits but NOT Bash.',
      lines: [
        'Unattended, it will stop and ask for approval before it can run your tests, ' +
          'and report that as a finished task.',
        'Use bypassPermissions, or list Bash in allowed_tools.',
      ],
    });
  }

  if (config.agents.reviewer && config.agents.reviewer.provider === builder.provider) {
    findings.push({
      id: 'config-agents:same-provider',
      label: 'agents',
      status: 'warn',
      detail:
        'builder and reviewer are the same provider — a model is a weak reviewer of its own output.',
      lines: ['Prefer a different vendor.'],
    });
  }

  if (config.gates.length === 0) {
    findings.push({
      id: 'config-agents:no-gates',
      label: 'agents',
      status: 'warn',
      detail: 'no gates configured.',
      lines: [
        'Without machine checks, nothing verifies the work but the reviewer.',
        'Add at least a typecheck and tests.',
      ],
    });
  }

  if (findings.length === 0) {
    return [{ id: 'config-agents', label: 'agents', status: 'ok', detail: 'no advisory warnings' }];
  }
  return findings;
}

const NPM_LIKE = ['npm', 'pnpm', 'yarn', 'bun'];

/** Static checks for a single gate: does its head token resolve, and — for npm-family
 * runners — does the named script exist in package.json. */
function buildGateChecks(gate: GateConfig, cwd: string): Check[] {
  const id = `gate:${gate.name}`;
  const label = `gate ${gate.name}`;

  if (gate.run.trim() === '') {
    return [{ id, label, status: 'warn', detail: 'empty command' }];
  }

  const token = headToken(gate.run);
  if (token === undefined) {
    return [
      {
        id,
        label,
        status: 'warn',
        detail: `cannot determine the executable statically from \`${gate.run}\``,
        remedy: 'nothing may be wrong — doctor cannot check this form',
      },
    ];
  }

  const resolved = resolveExecutable(token, cwd);
  const checks: Check[] = [];
  if (resolved) {
    checks.push({ id, label, status: 'ok', detail: resolved });
  } else if (gate.required) {
    checks.push({
      id,
      label,
      status: 'fail',
      detail: `\`${token}\` is not on PATH`,
      remedy:
        'install it, or fix the `run` command — an unrunnable required gate fails every attempt, ' +
        'and the runner blames the builder for it and burns every retry',
    });
  } else {
    checks.push({
      id,
      label,
      status: 'warn',
      detail: `\`${token}\` is not on PATH`,
      remedy: 'this gate is not required, so a run continues without it',
    });
  }

  if (NPM_LIKE.includes(token)) {
    const parts = gate.run.trim().split(/\s+/);
    const script = parts[2];
    if (parts[1] === 'run' && script !== undefined && /^[A-Za-z0-9:._-]+$/.test(script)) {
      const pkgPath = join(cwd, 'package.json');
      if (existsSync(pkgPath)) {
        let pkg: unknown;
        try {
          pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        } catch {
          pkg = undefined;
        }
        if (pkg !== undefined) {
          const scripts =
            typeof pkg === 'object' && pkg !== null
              ? (pkg as { scripts?: unknown }).scripts
              : undefined;
          const hasScript =
            typeof scripts === 'object' && scripts !== null && script in scripts;
          if (!hasScript) {
            checks.push({
              id: `${id}:script`,
              label,
              status: 'warn',
              detail: `package.json has no script "${script}"`,
              remedy: 'add it, or point the gate at a command that exists',
            });
          }
        }
      }
    }
  }

  return checks;
}

/**
 * The full doctor report: an ordered list of checks a human or a first run
 * would want answered before trusting the repository to `kalfa run`
 * unattended. Never throws — a check that fails unexpectedly becomes a
 * `fail` entry instead of aborting the rest of the report.
 */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const cwd = opts.cwd;
  const probeFn = opts.probe ?? probeCli;

  let configValue: KalfaConfig | undefined;
  const configCheck: Check = (() => {
    try {
      const { config, path } = loadConfig(cwd, opts.configPath);
      configValue = config;
      const lines: string[] = [];
      const builder = config.agents.builder;
      lines.push(`builder   ${builder.provider}${builder.model ? ` (${builder.model})` : ''}`);
      if (config.agents.reviewer) {
        const reviewer = config.agents.reviewer;
        lines.push(`reviewer  ${reviewer.provider}${reviewer.model ? ` (${reviewer.model})` : ''}`);
      } else {
        lines.push('reviewer  (none — review disabled)');
      }
      lines.push(`gates     ${config.gates.map((g) => g.name).join(', ') || '(none)'}`);
      return { id: 'config', label: 'config', status: 'ok', detail: path, lines };
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      const notFound = !existsSync(err.path);
      return {
        id: 'config',
        label: 'config',
        status: 'fail',
        detail: err.message,
        remedy: notFound
          ? 'run `kalfa init` to write a starter kalfa.yaml'
          : 'fix the fields listed above',
      };
    }
  })();

  const requiredSet = configCheck.status === 'ok' ? requiredProviders(configValue!) : undefined;

  const [claudeProbe, codexProbe] = await Promise.all([
    safeProbe('claude', probeFn),
    safeProbe('codex', probeFn),
  ]);

  const gitRepoCheck = guard('git-repo', 'git repo', () => {
    if (git.isRepo(cwd)) {
      return { id: 'git-repo', label: 'git repo', status: 'ok', detail: resolve(cwd) };
    }
    return {
      id: 'git-repo',
      label: 'git repo',
      status: 'fail',
      detail: 'not a git repository',
      remedy:
        'run `git init` and make an initial commit — kalfa relies on git for commits, stashing and rollback',
    };
  });

  const gitCommitsCheck = guard('git-commits', 'commits', () => {
    if (gitRepoCheck.status === 'fail') {
      return { id: 'git-commits', label: 'commits', status: 'skip', detail: 'not a git repository' };
    }
    if (!git.hasCommits(cwd)) {
      return {
        id: 'git-commits',
        label: 'commits',
        status: 'fail',
        detail: 'no commits yet',
        remedy: 'make an initial commit — kalfa commits each task on top of an existing history',
      };
    }
    let detail = '';
    try {
      const sha8 = git.headSha(cwd).slice(0, 8);
      const branch = git.currentBranch(cwd);
      detail = `${sha8} on ${branch}`;
    } catch {
      detail = '';
    }
    return { id: 'git-commits', label: 'commits', status: 'ok', detail };
  });

  const gitCleanCheck = guard('git-clean', 'clean tree', () => {
    if (gitRepoCheck.status === 'fail') {
      return { id: 'git-clean', label: 'clean tree', status: 'skip', detail: 'not a git repository' };
    }
    if (gitCommitsCheck.status === 'fail') {
      return { id: 'git-clean', label: 'clean tree', status: 'skip', detail: 'no commits yet' };
    }
    try {
      const lines = git.statusLines(cwd);
      if (lines.length === 0) {
        return { id: 'git-clean', label: 'clean tree', status: 'ok', detail: 'clean' };
      }
      const n = lines.length;
      return {
        id: 'git-clean',
        label: 'clean tree',
        status: 'fail',
        detail: `${n} uncommitted change${n === 1 ? '' : 's'}`,
        lines: lines.slice(0, 10),
        remedy: 'commit or stash first, so kalfa can tell its own work from yours',
      };
    } catch (err) {
      if (err instanceof git.GitError) {
        return { id: 'git-clean', label: 'clean tree', status: 'fail', detail: err.message };
      }
      throw err;
    }
  });

  const cliClaudeCheck = guard('cli-claude', 'claude CLI', () => {
    if (claudeProbe instanceof Error) throw claudeProbe;
    return { id: 'cli-claude', label: 'claude CLI', ...classifyProbe('claude', claudeProbe, requiredSet) };
  });

  const cliCodexCheck = guard('cli-codex', 'codex CLI', () => {
    if (codexProbe instanceof Error) throw codexProbe;
    return { id: 'cli-codex', label: 'codex CLI', ...classifyProbe('codex', codexProbe, requiredSet) };
  });

  const configAgentsChecks: Check[] =
    configCheck.status !== 'ok'
      ? [{ id: 'config-agents', label: 'agents', status: 'skip', detail: 'config could not be loaded' }]
      : guardMany('config-agents', 'agents', () => buildConfigAgentsChecks(configValue!));

  let planValue: Plan | undefined;
  const planCheck: Check = guard('plan', 'plan', () => {
    try {
      const { plan, path } = loadPlan(cwd, opts.planPath ?? 'kalfa.plan.json');
      planValue = plan;
      const n = plan.tasks.length;
      return {
        id: 'plan',
        label: 'plan',
        status: 'ok',
        detail: path,
        lines: [`${n} task${n === 1 ? '' : 's'}`, plan.goal.slice(0, 100)],
      };
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      const notFound = !existsSync(err.path);
      return {
        id: 'plan',
        label: 'plan',
        status: 'fail',
        detail: err.message,
        remedy: notFound
          ? 'run `kalfa plan` to generate one, or `kalfa init` for a template'
          : 'fix the fields listed above',
      };
    }
  });

  const planGatesChecks: Check[] = (() => {
    if (configCheck.status !== 'ok' || planCheck.status !== 'ok') {
      const detail = configCheck.status !== 'ok' ? 'config could not be loaded' : 'plan could not be loaded';
      return [{ id: 'plan-gates', label: 'plan gates', status: 'skip', detail }];
    }
    return guardMany('plan-gates', 'plan gates', () => {
      const gateNames = new Set(configValue!.gates.map((g) => g.name));
      const offenses: Check[] = [];
      for (const task of planValue!.tasks) {
        if (!task.gates) continue;
        for (const name of task.gates) {
          if (!gateNames.has(name)) {
            offenses.push({
              id: `plan-gates:${task.id}:${name}`,
              label: 'plan gates',
              status: 'fail',
              detail: `task ${task.id} names gate "${name}", which is not in the config`,
              remedy:
                'add the gate to kalfa.yaml or remove it from the task — gatesForTask silently drops ' +
                'unknown names, so this task would run with no machine verification at all',
            });
          }
        }
      }
      if (offenses.length === 0) {
        return [
          { id: 'plan-gates', label: 'plan gates', status: 'ok', detail: 'all task gate references resolve' },
        ];
      }
      return offenses;
    });
  })();

  const gateChecks: Check[] =
    configCheck.status !== 'ok'
      ? [{ id: 'gates', label: 'gates', status: 'skip', detail: 'config could not be loaded' }]
      : configValue!.gates.flatMap((gate) =>
          guardMany(`gate:${gate.name}`, `gate ${gate.name}`, () => buildGateChecks(gate, cwd)),
        );

  const checks: Check[] = [
    gitRepoCheck,
    gitCommitsCheck,
    gitCleanCheck,
    cliClaudeCheck,
    cliCodexCheck,
    configCheck,
    ...configAgentsChecks,
    planCheck,
    ...planGatesChecks,
    ...gateChecks,
  ];

  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) counts[check.status] += 1;

  return { ok: counts.fail === 0, checks, counts };
}
