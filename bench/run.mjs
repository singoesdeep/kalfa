#!/usr/bin/env node
/**
 * Run kalfa against fixed scenarios, repeatedly, and write down what happened.
 *
 * Everything kalfa claims about itself is currently an anecdote: "the reviewer
 * caught a real defect twice", "the builder never took the cheap way out under
 * several adversarial framings". Those are the two most important claims in
 * the README and both are n≈2, recalled by hand. A stochastic system needs
 * rates, and rates need repetition.
 *
 * It also answers a question opened by the claim check: that check only sees
 * findings the reviewer labels `file_changed`, and nothing stops a model from
 * labelling everything `other` and never being checked. One run cannot tell.
 *
 * THIS COSTS REAL MONEY — one builder pass and one review per repetition, and
 * the codex half of that is not even reported. Dry runs are free and do
 * everything except call an agent.
 *
 *   node bench/run.mjs --dry-run                     free: fixtures + doctor + validate
 *   node bench/run.mjs --scenario money --repeat 3 --yes
 *   node bench/run.mjs --repeat 5 --yes              every scenario, 5 times each
 *
 * Results append to bench/results/<stamp>.jsonl, one row per run. Read them
 * with `node bench/report.mjs`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, scenarioByName } from './scenarios.mjs';
import { collect } from './collect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KALFA = join(HERE, '..', 'dist', 'cli', 'main.js');

function parseArgs(argv) {
  const args = { scenario: 'all', repeat: 1, dryRun: false, yes: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--yes') args.yes = true;
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--scenario') args.scenario = argv[++i];
    else if (arg === '--repeat') args.repeat = Number(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * A throwaway repository holding one scenario, committed and clean.
 *
 * Fresh per repetition, deliberately. Resuming or reusing would make each run
 * depend on the last, and the thing being measured is what kalfa does from a
 * standing start.
 */
function materialize(scenario, label) {
  const dir = mkdtempSync(join(tmpdir(), `kalfa-bench-${scenario.name}-${label}-`));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'bench@example.com']);
  git(dir, ['config', 'user.name', 'Bench']);
  git(dir, ['config', 'commit.gpgsign', 'false']);

  for (const [rel, content] of Object.entries(scenario.files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  writeFileSync(join(dir, 'kalfa.yaml'), scenario.config, 'utf8');
  writeFileSync(join(dir, 'kalfa.plan.json'), `${JSON.stringify(scenario.plan, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');

  git(dir, ['add', '--all']);
  git(dir, ['commit', '-q', '-m', `bench fixture: ${scenario.name}`]);
  return dir;
}

function kalfa(dir, args, { quiet = true } = {}) {
  const result = spawnSync(process.execPath, [KALFA, ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The build under test, so a row can be traced to the code that produced it. */
function kalfaRevision() {
  try {
    const sha = git(HERE, ['rev-parse', '--short', 'HEAD']);
    const dirty = git(HERE, ['status', '--porcelain']).length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(KALFA)) {
  console.error('build first: npm run build');
  process.exit(1);
}

const chosen =
  args.scenario === 'all'
    ? SCENARIOS
    : [scenarioByName(args.scenario)].filter(Boolean);

if (chosen.length === 0) {
  console.error(`unknown scenario: ${args.scenario}`);
  console.error(`known: ${SCENARIOS.map((s) => s.name).join(', ')}, all`);
  process.exit(1);
}

const total = chosen.length * args.repeat;

console.log(`kalfa bench · build ${kalfaRevision()}`);
for (const scenario of chosen) console.log(`  ${scenario.name.padEnd(12)} ${scenario.why}`);
console.log(`\n${chosen.length} scenario(s) × ${args.repeat} = ${total} run(s)`);

// A benchmark is exactly the shape of thing someone runs with --repeat 50 by
// accident. It says what it is about to spend and waits to be told twice.
if (!args.dryRun && !args.yes) {
  console.log(
    `\nEach run calls a builder and a reviewer for real. Rough order: a few\n` +
      `tenths of a dollar per run for the builder, plus a codex review that\n` +
      `reports no cost at all.\n\n` +
      `Re-run with --yes to spend it, or --dry-run to check the fixtures for free.`,
  );
  process.exit(0);
}

const outDir = join(HERE, 'results');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = args.out ?? join(outDir, `${stamp}.jsonl`);

let spent = 0;
let failures = 0;

for (const scenario of chosen) {
  for (let rep = 1; rep <= args.repeat; rep += 1) {
    const label = `${rep}`;
    const dir = materialize(scenario, label);
    const head = `[${scenario.name} ${rep}/${args.repeat}]`;

    // doctor first, always. It runs nothing and spends nothing, and a fixture
    // that cannot start is a bug in the bench rather than a data point.
    const doctor = kalfa(dir, ['doctor']);
    if (doctor.status !== 0) {
      console.log(`${head} SKIPPED — doctor refused:\n${doctor.stdout}${doctor.stderr}`);
      failures += 1;
      continue;
    }

    if (args.dryRun) {
      const validate = kalfa(dir, ['validate']);
      if (validate.status !== 0) failures += 1;

      // A scenario is allowed to assert that it still means what it claims.
      // The impossible one nearly shipped with its trap already closed —
      // MAX_SAFE_INTEGER round-trips fine under the implementation the plan
      // mandates — which would have produced rows about behaviour under
      // pressure with no pressure in them.
      let check = '';
      if (scenario.selfCheck) {
        const result = scenario.selfCheck();
        if (!result.ok) failures += 1;
        check = ` · premise ${result.ok ? 'holds' : 'BROKEN'}: ${result.detail}`;
      }

      console.log(
        `${head} ${validate.status === 0 ? 'plan validates' : 'PLAN INVALID'}${check}
    ${dir}`,
      );
      continue;
    }

    const started = Date.now();
    const run = kalfa(dir, ['run']);
    const row = collect(dir, {
      at: new Date().toISOString(),
      build: kalfaRevision(),
      scenario: scenario.name,
      repetition: rep,
      exitStatus: run.status,
      driverMs: Date.now() - started,
      ...(args.keep ? { repo: dir } : {}),
    });

    appendFileSync(outPath, `${JSON.stringify(row)}\n`, 'utf8');
    spent += row.builderCostUsd ?? 0;

    const t = row.tasks ?? {};
    console.log(
      `${head} ${t.done ?? 0} done, ${t.blocked ?? 0} blocked · ` +
        `${row.review?.findings ?? 0} finding(s), ${row.review?.blocking ?? 0} blocking · ` +
        `$${(row.builderCostUsd ?? 0).toFixed(4)}+ · ${Math.round((row.driverMs ?? 0) / 1000)}s` +
        (row.notes?.length ? `\n    ! ${row.notes.join('; ')}` : ''),
    );
  }
}

if (args.dryRun) {
  console.log(`\n${total - failures}/${total} fixtures ready. Nothing was spent.`);
  process.exit(failures > 0 ? 1 : 0);
}

console.log(`\nwrote ${outPath}`);
console.log(`builder spend $${spent.toFixed(4)}+ — the reviewer's is not reported by its CLI`);
console.log(`read it with: node bench/report.mjs`);
