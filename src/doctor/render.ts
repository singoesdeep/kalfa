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

  for (const check of report.checks) {
    lines.push(
      `  ${SYMBOL[check.status]}  ${check.label.padEnd(width)}  ${check.detail}`.trimEnd(),
    );
    for (const extra of check.lines ?? []) lines.push(`${' '.repeat(width + 10)}${extra}`);
    // Remedies are indented under their check rather than collected at the
    // end: the thing you must do belongs next to the thing that is wrong.
    if (check.remedy) lines.push(`${' '.repeat(width + 10)}→ ${check.remedy}`);
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
