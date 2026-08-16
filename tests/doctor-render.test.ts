import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/doctor/render.js';
import type { DoctorReport } from '../src/doctor/doctor.js';

const report = (over: Partial<DoctorReport> = {}): DoctorReport => ({
  ok: false,
  checks: [
    { id: 'git-repo', label: 'git repo', status: 'ok', detail: '/tmp/x' },
    {
      id: 'git-clean',
      label: 'clean tree',
      status: 'fail',
      detail: '2 uncommitted changes',
      lines: [' M a.ts', '?? b.ts'],
      remedy: 'commit or stash first',
    },
    { id: 'gates', label: 'gates', status: 'skip', detail: 'config could not be loaded' },
  ],
  counts: { ok: 1, warn: 0, fail: 1, skip: 1 },
  ...over,
});

describe('renderReport', () => {
  it('puts the remedy next to the thing that is wrong', () => {
    const lines = renderReport(report()).split('\n');
    const failIndex = lines.findIndex((l) => l.includes('FAIL'));
    const remedyIndex = lines.findIndex((l) => l.includes('→ commit or stash'));
    expect(failIndex).toBeGreaterThanOrEqual(0);
    // Not collected at the end: you should not have to scroll to find it.
    expect(remedyIndex - failIndex).toBeLessThanOrEqual(3);
  });

  it('shows the supporting detail lines under their check', () => {
    const text = renderReport(report());
    expect(text).toContain('M a.ts');
    expect(text).toContain('?? b.ts');
  });

  it('counts only the statuses that occurred', () => {
    const text = renderReport(report());
    expect(text).toContain('1 ok');
    expect(text).toContain('1 failed');
    expect(text).toContain('1 skipped');
    expect(text).not.toContain('warning');
  });

  it('says plainly whether a run would be stopped', () => {
    expect(renderReport(report())).toContain('not ready');
    expect(
      renderReport(report({ ok: true, counts: { ok: 3, warn: 0, fail: 0, skip: 0 } })),
    ).toContain('ready — nothing here would stop');
  });

  it('pads labels to a common width so details line up', () => {
    const text = renderReport(report());
    // The longest label sets the column; a short one is padded to match, so
    // the detail text starts at the same offset on every check line.
    const repoLine = text.split('\n').find((l) => l.includes('git repo'))!;
    const cleanLine = text.split('\n').find((l) => l.includes('clean tree'))!;
    expect(repoLine.indexOf('/tmp/x')).toBe(cleanLine.indexOf('2 uncommitted'));
  });
});

/**
 * Both defects were reported from a real run of the delivered feature: a
 * config that fails validation lists every problem, and those continuation
 * lines wrapped back to the margin where they read as separate checks.
 */
describe('renderReport: multi-line details', () => {
  const multi: DoctorReport = {
    ok: false,
    checks: [
      { id: 'git-repo', label: 'git repo', status: 'ok', detail: '/tmp/x' },
      {
        id: 'config',
        label: 'config',
        status: 'fail',
        detail: 'kalfa.yaml is not valid:\n(root): review is true but no reviewer\ngates.0.run: required',
        remedy: 'fix the fields listed above',
      },
    ],
    counts: { ok: 1, warn: 0, fail: 1, skip: 0 },
  };

  it('indents continuation lines to the detail column', () => {
    const lines = renderReport(multi).split('\n');
    const head = lines.find((l) => l.includes('is not valid'))!;
    const cont = lines.find((l) => l.includes('(root):'))!;
    expect(cont.indexOf('(root):')).toBe(head.indexOf('kalfa.yaml'));
  });

  it('keeps every problem, not just the first', () => {
    const text = renderReport(multi);
    expect(text).toContain('(root): review is true but no reviewer');
    expect(text).toContain('gates.0.run: required');
  });

  it('still puts the remedy after the whole detail', () => {
    const lines = renderReport(multi).split('\n');
    expect(lines.findIndex((l) => l.includes('→ fix the fields'))).toBeGreaterThan(
      lines.findIndex((l) => l.includes('gates.0.run')),
    );
  });
});
