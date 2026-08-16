import { spawn } from 'node:child_process';
import type { NotifyConfig } from '../config/schema.js';
import type { TaskStatus } from '../types.js';

/**
 * How the operator finds out the run needs them.
 *
 * Kalfa deliberately owns no integrations. There is no Slack client here, no
 * SMTP, no desktop toast — one shell command, a JSON payload on stdin, and
 * `KALFA_*` in the environment for the one-liner case. That is enough to build
 * any of those in three lines, and it keeps Kalfa out of the business of
 * maintaining them.
 *
 * The hook makes no API calls and cannot change the run's outcome: it fires
 * after the last commit, its failure is reported and never propagated, and it
 * is killed if it hangs. A notification that could break a finished run would
 * be worse than no notification.
 */

export type NotifyEvent = 'completed' | 'blocked' | 'failed';

export interface NotifyPayload {
  event: NotifyEvent;
  runId: string;
  branch?: string;
  goal?: string;
  counts?: Record<TaskStatus, number>;
  costUsd?: number;
  /** True when the total is a floor — see AgentRun.costKnown. */
  costIncomplete?: boolean;
  stoppedEarly?: string;
  /** Set for the 'failed' event: why the run never got going. */
  error?: string;
  paths: {
    tasks: string;
    blocked: string;
    journal: string;
    runDir?: string;
    adrs: string;
  };
}

/**
 * Fire the hook, if one is configured and this event is one it asked for.
 *
 * Resolves when the command exits, is killed on timeout, or fails to start.
 * The returned string is a warning worth printing; undefined means it either
 * did not apply or worked.
 */
export async function notify(
  config: NotifyConfig,
  payload: NotifyPayload,
  cwd: string,
): Promise<string | undefined> {
  if (!config.command) return undefined;
  if (!config.on.includes(payload.event)) return undefined;

  const body = JSON.stringify(payload, null, 2);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(config.command as string, {
        cwd,
        shell: true,
        stdio: ['pipe', 'ignore', 'pipe'],
        env: {
          ...process.env,
          // The one-liner case: `notify-send "kalfa $KALFA_EVENT"`.
          KALFA_EVENT: payload.event,
          KALFA_RUN_ID: payload.runId,
          KALFA_BRANCH: payload.branch ?? '',
          KALFA_DONE: String(payload.counts?.done ?? 0),
          KALFA_BLOCKED: String(payload.counts?.blocked ?? 0),
          KALFA_SKIPPED: String(payload.counts?.skipped ?? 0),
          KALFA_COST_USD: String(payload.costUsd ?? 0),
          KALFA_RUN_DIR: payload.paths.runDir ?? '',
        },
      });
    } catch (err) {
      resolve(`notify command could not be started: ${(err as Error).message}`);
      return;
    }

    let stderr = '';
    let settled = false;
    const finish = (warning?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(warning);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(`notify command timed out after ${config.timeout_ms}ms`);
    }, config.timeout_ms);

    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (err) => finish(`notify command failed: ${err.message}`));
    child.on('close', (code) =>
      finish(code === 0 ? undefined : `notify command exited ${code}: ${stderr.trim().slice(0, 400)}`),
    );

    child.stdin?.on('error', () => {
      // A hook that never reads stdin is a perfectly reasonable hook.
    });
    child.stdin?.end(body, 'utf8');
  });
}
