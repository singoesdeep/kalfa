#!/usr/bin/env node
/**
 * What the rows add up to.
 *
 * Reports rates and nothing else. Whether a particular block was correct is
 * not something a script can know, and a benchmark that guessed would be worse
 * than one that puts the number in front of a person — the same bargain kalfa
 * makes with the morning diff.
 *
 *   node bench/report.mjs                 every file in bench/results/
 *   node bench/report.mjs a.jsonl b.jsonl
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function rowsFrom(paths) {
  return paths.flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      }),
  );
}

const explicit = process.argv.slice(2);
const paths =
  explicit.length > 0
    ? explicit
    : existsSync(join(HERE, 'results'))
      ? readdirSync(join(HERE, 'results'))
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => join(HERE, 'results', f))
      : [];

if (paths.length === 0) {
  console.error('no result files. run: node bench/run.mjs --repeat 3 --yes');
  process.exit(1);
}

const rows = rowsFrom(paths).filter((r) => !r.error);
if (rows.length === 0) {
  console.error('result files contain no usable rows');
  process.exit(1);
}

const byScenario = new Map();
for (const row of rows) {
  const key = row.scenario ?? 'unknown';
  byScenario.set(key, [...(byScenario.get(key) ?? []), row]);
}

const sum = (list, fn) => list.reduce((acc, r) => acc + (fn(r) ?? 0), 0);
const mean = (list, fn) => (list.length === 0 ? 0 : sum(list, fn) / list.length);
const pct = (part, whole) => (whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`);

console.log(`kalfa bench · ${rows.length} run(s) across ${byScenario.size} scenario(s)`);
console.log(`builds: ${[...new Set(rows.map((r) => r.build))].join(', ')}\n`);

for (const [scenario, list] of byScenario) {
  const n = list.length;
  const tasks = sum(list, (r) => r.tasks?.total);
  const done = sum(list, (r) => r.tasks?.done);
  const blocked = sum(list, (r) => r.tasks?.blocked);
  const unfinished = sum(list, (r) => r.tasks?.unfinished);

  console.log(`${scenario}  (n=${n})`);
  console.log(
    `  tasks       ${done}/${tasks} done · ${blocked} blocked (${pct(blocked, tasks)})` +
      (unfinished > 0 ? ` · ${unfinished} never finished` : ''),
  );
  console.log(
    `  attempts    ${mean(list, (r) => r.attempts).toFixed(2)} per run · ` +
      `gates failed ${sum(list, (r) => r.gates?.failed)}/${sum(list, (r) => r.gates?.runs)}`,
  );
  console.log(
    `  cost        $${mean(list, (r) => r.builderCostUsd).toFixed(4)}+ per run · ` +
      `${Math.round(mean(list, (r) => r.driverMs) / 1000)}s`,
  );

  const findings = sum(list, (r) => r.review?.findings);
  const claims = ['file_changed', 'other', 'absent'].map(
    (k) => `${k} ${sum(list, (r) => r.review?.claims?.[k])}`,
  );
  console.log(
    `  review      ${findings} finding(s), ${sum(list, (r) => r.review?.blocking)} blocking · ` +
      `${sum(list, (r) => r.review?.unparseable)} unparseable · ` +
      `${sum(list, (r) => r.review?.errors)} errored`,
  );

  /**
   * The headline the check depends on.
   *
   * Only `file_changed` findings are checkable against the diff. If a reviewer
   * learns to label everything `other`, the check still passes every test and
   * verifies nothing — and this line is the only place that shows it.
   */
  console.log(`  claims      ${claims.join(' · ')}`);
  console.log(
    `  checked     supported ${sum(list, (r) => r.review?.checks?.supported)} · ` +
      `refuted ${sum(list, (r) => r.review?.discarded)} · ` +
      `unverifiable ${sum(list, (r) => r.review?.checks?.unverifiable)}`,
  );

  const touched = list.filter((r) => (r.protectedTouched ?? []).length > 0).length;
  console.log(
    `  tests       modified in ${touched}/${n} run(s) (${pct(touched, n)}) · ` +
      `${sum(list, (r) => r.adrsWritten)} decision record(s)`,
  );

  const noted = list.filter((r) => (r.notes ?? []).length > 0).length;
  if (noted > 0) console.log(`  agents      misbehaved but survived in ${noted}/${n} run(s)`);
  console.log('');
}

// Said once, at the end, rather than implied by every dollar figure above.
if (rows.some((r) => r.costIncomplete)) {
  console.log('every cost here is a FLOOR: the codex CLI reports no per-run spend.');
}
