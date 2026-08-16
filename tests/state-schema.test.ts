import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STATE_SCHEMA_VERSION,
  StateError,
  parseState,
  readStateFile,
} from '../src/state/schema.js';
import { StateStore, readRunRecord } from '../src/state/store.js';
import { runDoctor } from '../src/doctor/doctor.js';

/**
 * Upgrading Kalfa must not cost the user a run.
 *
 * The case this pins down is not hypothetical: the first real-project run
 * finished with a blocked task, a recoverable stash and eight tasks left, and
 * the documented next step was "upgrade kalfa, then resume the same run id".
 * Every test here is one way that sentence could have gone wrong.
 */

let dir: string;

const statePath = (): string => join(dir, '.kalfa', 'state.json');

/** State exactly as Kalfa 0.1.0 wrote it: no version stamp anywhere. */
const legacyState = (): Record<string, unknown> => ({
  runId: '20260816-031500',
  startedAt: '2026-08-16T03:15:00.000Z',
  planPath: 'kalfa.plan.json',
  branch: 'kalfa/20260816-031500',
  baseCommit: 'abc1234',
  tasks: {
    T1: {
      id: 'T1',
      status: 'done',
      attempts: [
        {
          attempt: 1,
          agentCostUsd: 0.4,
          reviewCostUsd: 0.1,
          durationMs: 1000,
          gates: [{ name: 'typecheck', ok: true, exitCode: 0, output: '', durationMs: 5 }],
          reviewFindings: 0,
          blockingFindings: 0,
          outcome: 'passed',
        },
      ],
      commit: 'deadbee',
      costUsd: 0.5,
      durationMs: 1000,
    },
    T5: {
      id: 'T5',
      status: 'blocked',
      attempts: [],
      reason: 'reviewer held the line',
      stashRef: 'stash@{0}',
      protectedPaths: ['tests/limiter.test.ts'],
      costUsd: 0.25,
      durationMs: 900,
    },
  },
});

const writeState = (value: unknown): void => {
  mkdirSync(join(dir, '.kalfa'), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(value, null, 2), 'utf8');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kalfa-state-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('reading state written by an older kalfa', () => {
  it('migrates an unstamped 0.1.0 record instead of rejecting it', () => {
    writeState(legacyState());
    const loaded = readStateFile(statePath())!;

    expect(loaded.diskVersion).toBe(0);
    expect(loaded.migrated).toBe(true);
    expect(loaded.record.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    expect(loaded.record.runId).toBe('20260816-031500');
  });

  it('keeps every task, cost, commit and stash ref the old run recorded', () => {
    writeState(legacyState());
    const { record } = readStateFile(statePath())!;

    expect(record.tasks['T1']?.status).toBe('done');
    expect(record.tasks['T1']?.commit).toBe('deadbee');
    expect(record.tasks['T1']?.attempts[0]?.gates[0]?.name).toBe('typecheck');
    expect(record.tasks['T5']?.stashRef).toBe('stash@{0}');
    expect(record.tasks['T5']?.protectedPaths).toEqual(['tests/limiter.test.ts']);
    expect(record.baseCommit).toBe('abc1234');
  });

  it('resumes the old run without repeating the task it already finished', () => {
    writeState(legacyState());
    const store = new StateStore(dir, '20260816-031500', 'kalfa.plan.json');

    expect(store.isDone('T1')).toBe(true);
    expect(store.run.tasks['T5']?.status).toBe('blocked');
    expect(store.totalCostUsd()).toBeCloseTo(0.75);
  });

  it('writes the migrated record back, stamped', () => {
    writeState(legacyState());
    new StateStore(dir, '20260816-031500', 'kalfa.plan.json');

    const onDisk = JSON.parse(readFileSync(statePath(), 'utf8')) as { schemaVersion: number };
    expect(onDisk.schemaVersion).toBe(STATE_SCHEMA_VERSION);
  });

  it('keeps a timestamped backup of the pre-migration file', () => {
    writeState(legacyState());
    new StateStore(dir, '20260816-031500', 'kalfa.plan.json');

    const backups = readdirSync(join(dir, '.kalfa')).filter((f) => f.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toContain('.v0.');
    const original = JSON.parse(readFileSync(join(dir, '.kalfa', backups[0]!), 'utf8')) as {
      schemaVersion?: number;
    };
    expect(original.schemaVersion).toBeUndefined();
  });

  it('does not migrate again on the next open', () => {
    writeState(legacyState());
    new StateStore(dir, '20260816-031500', 'kalfa.plan.json');
    new StateStore(dir, '20260816-031500', 'kalfa.plan.json');

    expect(readdirSync(join(dir, '.kalfa')).filter((f) => f.endsWith('.bak'))).toHaveLength(1);
  });

  it('is idempotent: migrating an already-current record changes nothing', () => {
    const current = { ...legacyState(), schemaVersion: STATE_SCHEMA_VERSION };
    const first = parseState(current, 'state.json');
    const second = parseState(first.record, 'state.json');

    expect(first.migrated).toBe(false);
    expect(second.record).toEqual(first.record);
  });

  it('preserves fields it does not know about rather than stripping them', () => {
    // A patch release that adds a field must not have it deleted by the first
    // older reader that touches the file.
    writeState({ ...legacyState(), somethingNewer: { keep: 'me' } });
    const { record } = readStateFile(statePath())!;

    expect((record as unknown as { somethingNewer: unknown }).somethingNewer).toEqual({
      keep: 'me',
    });
  });
});

describe('state this build cannot read', () => {
  it('reports the file and the offending field, not a generic parse error', () => {
    const broken = legacyState();
    (broken['tasks'] as Record<string, Record<string, unknown>>)['T1']!['status'] = 'finished';
    writeState(broken);

    const err = (() => {
      try {
        readStateFile(statePath());
      } catch (e) {
        return e as StateError;
      }
      return undefined;
    })();

    expect(err).toBeInstanceOf(StateError);
    expect(err!.problem).toBe('invalid');
    expect(err!.message).toContain('tasks.T1.status');
    expect(err!.message).toContain(statePath());
  });

  it('refuses rather than silently starting a fresh run', () => {
    writeState({ runId: 'r1', tasks: 'not a map of tasks' });
    expect(() => new StateStore(dir, 'r1', 'kalfa.plan.json')).toThrow(StateError);
  });

  it('treats truncated JSON as a problem, not as an empty repository', () => {
    mkdirSync(join(dir, '.kalfa'), { recursive: true });
    writeFileSync(statePath(), '{"runId": "r1", "tas', 'utf8');

    expect(() => readRunRecord(dir)).toThrow(/not valid JSON/);
  });

  it('rejects state from a newer kalfa without touching it', () => {
    const future = { ...legacyState(), schemaVersion: STATE_SCHEMA_VERSION + 1 };
    writeState(future);
    const before = readFileSync(statePath(), 'utf8');

    expect(() => new StateStore(dir, '20260816-031500', 'kalfa.plan.json')).toThrow(
      /newer kalfa/,
    );
    expect(readFileSync(statePath(), 'utf8')).toBe(before);
    expect(readdirSync(join(dir, '.kalfa')).filter((f) => f.endsWith('.bak'))).toHaveLength(0);
  });

  it('rejects a schemaVersion that is not a whole number', () => {
    writeState({ ...legacyState(), schemaVersion: 'one' });
    expect(() => readStateFile(statePath())).toThrow(/unreadable schemaVersion/);
  });

  it('reports no state at all as no state, not as an error', () => {
    expect(readRunRecord(dir)).toBeUndefined();
  });
});

describe('doctor reports state compatibility before a resume spends anything', () => {
  const doctorState = async (): Promise<{ status: string; detail: string; remedy?: string }> => {
    const report = await runDoctor({ cwd: dir, probe: async () => ({ found: false }) });
    const check = report.checks.find((c) => c.id === 'state')!;
    return { status: check.status, detail: check.detail, ...(check.remedy ? { remedy: check.remedy } : {}) };
  };

  it('skips quietly when nothing has run here', async () => {
    expect((await doctorState()).status).toBe('skip');
  });

  it('warns that an older run will be migrated, and says the run is resumable', async () => {
    writeState(legacyState());
    const check = await doctorState();

    expect(check.status).toBe('warn');
    expect(check.detail).toContain('v0');
    expect(check.detail).toContain('20260816-031500');
  });

  it('passes on state this build wrote', async () => {
    // The record reaches disk on the first write, not on construction.
    new StateStore(dir, 'r1', 'kalfa.plan.json').setStatus('T1', 'done');
    const check = await doctorState();

    expect(check.status).toBe('ok');
    expect(check.detail).toContain(`v${STATE_SCHEMA_VERSION}`);
  });

  it('fails, with a remedy, on state from a newer kalfa', async () => {
    writeState({ ...legacyState(), schemaVersion: STATE_SCHEMA_VERSION + 1 });
    const check = await doctorState();

    expect(check.status).toBe('fail');
    expect(check.remedy).toContain('upgrade kalfa');
  });

  it('fails on structurally broken state instead of reporting it as fine', async () => {
    writeState({ runId: 'r1' });
    expect((await doctorState()).status).toBe('fail');
  });
});
