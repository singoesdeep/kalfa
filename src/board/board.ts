import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { topoOrder, type Plan } from '../plan/schema.js';
import type { RunRecord, TaskRecord, TaskStatus } from '../types.js';

/**
 * TASKS.md — the board.
 *
 * `.kalfa/state.json` already records everything, but it is JSON in a hidden
 * directory: you cannot glance at it, it does not diff usefully, and no agent
 * is going to read it. The board is the same information rendered for the two
 * readers who actually need it mid-run — you, from another terminal, and the
 * next task, which starts with no memory of the previous ones.
 *
 * It is bounded by design. The decision records grow without limit as a run
 * proceeds; the board is always exactly one row per task, so handing it to a
 * task costs the same on task 30 as on task 1.
 *
 * Written after every status change, so a run killed mid-task still leaves an
 * accurate board behind.
 */

const MARKER: Record<TaskStatus, string> = {
  done: 'x',
  blocked: '!',
  skipped: '-',
  running: '~',
  pending: ' ',
};

const LABEL: Record<TaskStatus, string> = {
  done: 'done',
  blocked: 'blocked',
  skipped: 'skipped',
  running: 'running',
  pending: 'pending',
};

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** Last attempt's outcome, which is what you want to know about a failure. */
function lastFailure(record: TaskRecord | undefined): string {
  const last = record?.attempts[record.attempts.length - 1];
  if (!last) return '';
  switch (last.outcome) {
    case 'gate_failed': {
      const failed = last.gates.filter((g) => !g.ok && !g.skipped).map((g) => g.name);
      return failed.length > 0 ? `gate \`${failed.join('`, `')}\` failed` : 'a gate failed';
    }
    case 'review_failed':
      return last.blockingFindings > 0
        ? `${last.blockingFindings} blocking review finding${last.blockingFindings === 1 ? '' : 's'}`
        : 'the reviewer could not be read';
    case 'agent_failed':
      return 'the worker did not complete';
    case 'passed':
      return '';
  }
}

export function renderBoard(plan: Plan, run: RunRecord): string {
  const ordered = topoOrder(plan);
  const counts: Record<TaskStatus, number> = {
    done: 0,
    blocked: 0,
    skipped: 0,
    running: 0,
    pending: 0,
  };
  for (const task of ordered) {
    counts[run.tasks[task.id]?.status ?? 'pending'] += 1;
  }
  const totalCost = Object.values(run.tasks).reduce((sum, t) => sum + t.costUsd, 0);
  // Never present a floor as if it were the bill.
  const costLabel = run.costIncomplete ? `${usd(totalCost)}+` : usd(totalCost);

  const summary = [
    `${counts.done}/${ordered.length} done`,
    counts.blocked > 0 ? `${counts.blocked} blocked` : '',
    counts.skipped > 0 ? `${counts.skipped} skipped` : '',
    counts.running > 0 ? `${counts.running} running` : '',
    counts.pending > 0 ? `${counts.pending} pending` : '',
    costLabel,
  ]
    .filter(Boolean)
    .join(' · ');

  const lines: string[] = [
    `# Tasks`,
    ``,
    `Written by Kalfa. Regenerated on every status change — edits here are lost.`,
    ``,
    `**Goal:** ${plan.goal}`,
    ``,
    `**Run:** \`${run.runId}\`${run.branch ? ` · branch \`${run.branch}\`` : ''} · started ${run.startedAt}`,
    run.finishedAt ? `**Finished:** ${run.finishedAt}` : `**Status:** in progress`,
    ``,
    summary,
    ``,
    ...(run.costIncomplete
      ? [
          `> Costs are a FLOOR, not a total: the codex CLI does not report per-run`,
          `> cost, so the reviewer's spend is missing from every figure here.`,
          ``,
        ]
      : []),
    `| # | Task | Status | Attempts | Commit | Cost |`,
    `|---|---|---|---|---|---|`,
  ];

  for (const [i, task] of ordered.entries()) {
    const record = run.tasks[task.id];
    const status = record?.status ?? 'pending';
    lines.push(
      `| ${i + 1} | \`[${MARKER[status]}]\` ${task.id}: ${task.title} ` +
        `| ${LABEL[status]} ` +
        `| ${record?.attempts.length ?? 0} ` +
        `| ${record?.commit ? `\`${record.commit.slice(0, 8)}\`` : '—'} ` +
        `| ${record ? usd(record.costUsd) : '—'} |`,
    );
  }

  // Above "Needs you", because a test that moved with the implementation is
  // the thing most worth a human's eyes and the thing least likely to have
  // announced itself as a problem.
  const touchedTests = ordered
    .map((task) => ({ task, files: run.tasks[task.id]?.protectedPaths ?? [] }))
    .filter((entry) => entry.files.length > 0);

  if (touchedTests.length > 0) {
    lines.push(
      ``,
      `## Tests and checks were modified`,
      ``,
      `These tasks changed files that are supposed to be judging the work.`,
      `That is sometimes right and sometimes how a bad change gets through.`,
      `Read these diffs first.`,
      ``,
    );
    for (const { task, files } of touchedTests) {
      const record = run.tasks[task.id];
      lines.push(`### ${task.id}: ${task.title}`, ``);
      for (const file of files) lines.push(`- \`${file}\``);
      lines.push(
        ``,
        record?.commit
          ? `\`git show ${record.commit.slice(0, 8)}\``
          : `(not committed — the work is in the stash)`,
        ``,
      );
    }
  }

  // A reviewer that made a claim about a file the diff never touched is worth
  // a line whether or not the task went on to pass — especially then, because
  // nothing else in the morning would mention it.
  const refuted = ordered
    .map((task) => ({ task, lines: run.tasks[task.id]?.discardedFindings ?? [] }))
    .filter((entry) => entry.lines.length > 0);

  if (refuted.length > 0) {
    lines.push(
      ``,
      `## Review findings the diff did not support`,
      ``,
      `These findings claimed this diff changed a file that \`git\` shows it did`,
      `not touch. They were discarded: they never blocked a task and never cost`,
      `an attempt. Listed because a reviewer inventing a change is a fact about`,
      `the review, not about the code.`,
      ``,
    );
    for (const { task, lines: found } of refuted) {
      lines.push(`### ${task.id}: ${task.title}`, ``);
      for (const line of found) lines.push(`- ${line}`);
      lines.push(``);
    }
  }

  // A run that resolved every task without recording one decision is worth
  // noticing. It means either the spec left nothing to assume — the good case
  // — or assumptions were made and never written down. Kalfa cannot tell which;
  // it can refuse to let the question go unasked.
  const adrs = Object.values(run.tasks).reduce((sum, t) => sum + (t.adrsWritten ?? 0), 0);
  if (counts.done > 0 && adrs === 0) {
    lines.push(
      ``,
      `## No decisions were recorded`,
      ``,
      `${counts.done} task(s) completed and none produced a decision record.`,
      `That is the right outcome if the spec left nothing open. If it did leave`,
      `something open, the assumption was made anyway and is now only visible in`,
      `the diff.`,
      ``,
    );
  }

  const stuck = ordered.filter((task) => {
    const status = run.tasks[task.id]?.status;
    return status === 'blocked' || status === 'skipped';
  });

  if (stuck.length > 0) {
    lines.push(``, `## Needs you`, ``);
    for (const task of stuck) {
      const record = run.tasks[task.id]!;
      lines.push(`### ${task.id}: ${task.title}`, ``);
      lines.push(`- **Status:** ${LABEL[record.status]}`);
      if (record.reason) lines.push(`- **Reason:** ${record.reason}`);
      const failure = lastFailure(record);
      if (failure) lines.push(`- **Last attempt:** ${failure}`);
      // Named here because a blocked task's records are inside the stash, so
      // the reader who goes looking in docs/adr/ finds nothing and concludes
      // the worker never reasoned about it. It usually did — at length.
      if (record.adrsWritten) {
        lines.push(
          `- **Decisions recorded:** ${record.adrsWritten} — its own account of why, ` +
            `${record.stashRef ? 'inside the stash below' : 'in `docs/adr/`'}`,
        );
      }
      if (record.stashRef) {
        lines.push(
          `- **Abandoned work:** parked in stash \`${record.stashRef.slice(0, 8)}\` — ` +
            `\`git stash list\` to find it, \`git stash apply\` to bring it back`,
        );
      }
      lines.push(``);
    }
  }

  const resumable = counts.pending > 0 || counts.blocked > 0 || counts.skipped > 0;
  lines.push(
    // A heading directly after a table row is not a heading in strict
    // Markdown; it renders as another row of the table.
    ``,
    `## Next`,
    ``,
    ...(resumable
      ? [
          `- \`kalfa run --run-id ${run.runId}\` — retry what is unfinished; done tasks are skipped`,
          `- Fix the plan first if a task blocked because it was wrong, not because it was hard`,
        ]
      : [`- Nothing outstanding. Review the diff: \`git log --oneline\`, \`docs/adr/\`.`]),
    ``,
  );

  return lines.join('\n');
}

export function writeBoard(cwd: string, plan: Plan, run: RunRecord): void {
  writeFileSync(join(cwd, 'TASKS.md'), renderBoard(plan, run), 'utf8');
}

/** One line per task, for the terminal. Same data, no markdown. */
export function renderBoardPlain(plan: Plan, run: RunRecord): string {
  const ordered = topoOrder(plan);
  const width = Math.max(...ordered.map((t) => t.id.length));
  const lines = ordered.map((task) => {
    const record = run.tasks[task.id];
    const status = record?.status ?? 'pending';
    const attempts = record && record.attempts.length > 1 ? `  (${record.attempts.length} attempts)` : '';
    const commit = record?.commit ? `  ${record.commit.slice(0, 8)}` : '';
    // Carried into the terminal view too: a task that rewrote a test is the
    // one thing worth noticing at a glance, not only in the markdown board.
    const tests = record?.protectedPaths?.length ? '  [tests modified]' : '';
    return `  [${MARKER[status]}] ${task.id.padEnd(width)}  ${LABEL[status].padEnd(8)}${commit}${attempts}${tests}  ${task.title}`;
  });
  return lines.join('\n');
}
