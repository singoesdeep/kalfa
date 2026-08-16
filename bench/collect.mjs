#!/usr/bin/env node
/**
 * A finished run, reduced to one row of data.
 *
 * No new instrumentation: everything here already exists in
 * `.kalfa/journal.jsonl` and `.kalfa/state.json`, written for an operator to
 * read in the morning. Reading it as data instead is the whole benchmark.
 *
 * Kept separate from the driver, and pure, so it can be pointed at any run —
 * including one you did by hand — and so the expensive half (spending money)
 * and the cheap half (deciding what it meant) can be debugged apart.
 *
 *   node bench/collect.mjs <repo-dir>     print the row for that repo's run
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Every journal line, ignoring anything unparseable rather than failing. */
export function readJournal(repo, stateDir = '.kalfa') {
  const path = join(repo, stateDir, 'journal.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function readState(repo, stateDir = '.kalfa') {
  const path = join(repo, stateDir, 'state.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const EMPTY_CLAIMS = { file_changed: 0, other: 0, absent: 0 };
const EMPTY_CHECKS = { supported: 0, unsupported: 0, unverifiable: 0, absent: 0 };

/**
 * Turn one repository's run into a row.
 *
 * Counts rather than judgements. Whether a block was correct is not something
 * this can know, and a benchmark that guessed would be worse than one that
 * reports the rate and leaves the reading to a person.
 */
export function collect(repo, extra = {}) {
  const events = readJournal(repo);
  const state = readState(repo);
  if (events.length === 0 || !state) return { ...extra, error: 'no run state found' };

  const of = (type) => events.filter((e) => e.type === type);
  const tasks = Object.values(state.tasks ?? {});

  const severities = { blocker: 0, major: 0, minor: 0 };
  const claims = { ...EMPTY_CLAIMS };
  const checks = { ...EMPTY_CHECKS };
  let findings = 0;
  let blocking = 0;
  let unparseable = 0;
  let reviewErrors = 0;

  for (const event of of('review_done')) {
    if (event.error) {
      reviewErrors += 1;
      if (String(event.error).includes('unparseable')) unparseable += 1;
    }
    blocking += event.blocking ?? 0;
    for (const finding of event.findings ?? []) {
      findings += 1;
      if (finding.severity in severities) severities[finding.severity] += 1;
      // The open question this benchmark exists to answer: the check only
      // applies to findings the reviewer labels `file_changed`, and nothing
      // stops a model from labelling everything `other` and never being
      // checked at all. One run cannot tell. A hundred can.
      const claim = finding.claim ?? 'absent';
      claims[claim] = (claims[claim] ?? 0) + 1;
      const check = finding.check?.status ?? 'absent';
      checks[check] = (checks[check] ?? 0) + 1;
    }
  }

  const gateRuns = of('gates_done');
  const gateFailures = gateRuns.filter((e) =>
    (e.results ?? []).some((g) => !g.ok && !g.skipped),
  ).length;

  const secondOpinions = of('second_opinion');

  const started = state.startedAt ? Date.parse(state.startedAt) : undefined;
  const finished = state.finishedAt ? Date.parse(state.finishedAt) : undefined;

  return {
    ...extra,
    runId: state.runId,
    finished: Boolean(state.finishedAt),
    stoppedEarly: state.stoppedEarly ?? null,
    wallClockMs: started && finished ? finished - started : null,

    tasks: {
      total: tasks.length,
      done: tasks.filter((t) => t.status === 'done').length,
      blocked: tasks.filter((t) => t.status === 'blocked').length,
      skipped: tasks.filter((t) => t.status === 'skipped').length,
      unfinished: tasks.filter((t) => t.status === 'running' || t.status === 'pending').length,
    },
    attempts: tasks.reduce((sum, t) => sum + (t.attempts?.length ?? 0), 0),

    // The builder's spend only. codex reports none, so every total here is a
    // floor and says so rather than passing itself off as the bill.
    builderCostUsd: Number(tasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0).toFixed(4)),
    costIncomplete: Boolean(state.costIncomplete),

    gates: { runs: gateRuns.length, failed: gateFailures },

    review: {
      invocations: of('review_done').length,
      errors: reviewErrors,
      unparseable,
      findings,
      blocking,
      severities,
      /** How the reviewer classified its own claims. */
      claims,
      /** What git said about the ones it classified as checkable. */
      checks,
      /** Findings the diff refuted, so they never blocked anything. */
      discarded: of('review_claims_discarded').reduce(
        (sum, e) => sum + (e.findings?.length ?? 0),
        0,
      ),
      secondOpinions: secondOpinions.length,
      overturned: of('second_opinion').filter((e) => e.withdrawn).length,
    },

    /** Tests or checks the work modified — the cheating surface. */
    protectedTouched: of('protected_paths_touched').flatMap((e) => e.files ?? []),
    adrsWritten: tasks.reduce((sum, t) => sum + (t.adrsWritten ?? 0), 0),
    /** Agents that misbehaved and were survived — see AgentRun.note. */
    notes: of('agent_note').map((e) => e.note),
  };
}

// pathToFileURL, not string surgery: on Windows argv[1] is `C:\...` and the
// url is `file:///C:/...`, and hand-rolling that comparison silently makes
// this file do nothing when run directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('usage: node bench/collect.mjs <repo-dir>');
    process.exit(1);
  }
  console.log(JSON.stringify(collect(repo, { repo }), null, 2));
}
