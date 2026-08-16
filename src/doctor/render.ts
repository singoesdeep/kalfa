import type { Check, DoctorReport } from './doctor.js';

/**
 * Rendering for `kalfa doctor`.
 *
 * The report is read in one of two moods: before a first run, where you want
 * to know what to install, and after something went wrong at 3am, where you
 * want the one line that explains it. Both want the same thing — status, then
 * the remedy — so failures carry an explicit next action and everything else
 * stays to one line.
 */

const SYMBOL: Record<Check['status'], string> = {
  ok: 'ok  ',
  warn: 'warn',
  fail: 'FAIL',
  skip: 'skip',
};

export function renderReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.label.length), 10);
  const lines: string[] = [];

  const indent = ' '.repeat(width + 10);

  for (const check of report.checks) {
    // A detail can be multi-line — a config that failed validation lists every
    // problem. Continuation lines are indented to the detail column; left
    // alone they wrap back to the margin and read as separate checks.
    const [first = '', ...rest] = check.detail.split('\n');
    lines.push(`  ${SYMBOL[check.status]}  ${check.label.padEnd(width)}  ${first}`.trimEnd());
    for (const line of rest) lines.push(`${indent}${line}`.trimEnd());

    for (const extra of check.lines ?? []) lines.push(`${indent}${extra}`);
    // Remedies are indented under their check rather than collected at the
    // end: the thing you must do belongs next to the thing that is wrong.
    if (check.remedy) lines.push(`${indent}→ ${check.remedy}`);
  }

  const { counts } = report;
  lines.push(
    ``,
    [
      `${counts.ok} ok`,
      counts.warn > 0 ? `${counts.warn} warning` : '',
      counts.fail > 0 ? `${counts.fail} failed` : '',
      counts.skip > 0 ? `${counts.skip} skipped` : '',
    ]
      .filter(Boolean)
      .join(', '),
  );

  lines.push(
    report.ok
      ? `\nready — nothing here would stop \`kalfa run\`.`
      : `\nnot ready — fix the FAIL lines above before running.`,
  );

  return lines.join('\n');
}
