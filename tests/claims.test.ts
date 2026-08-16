import { describe, expect, it } from 'vitest';
import { checkClaim, checkFindings, normalizeClaimPath, pathsMatch } from '../src/review/claims.js';
import type { ReviewFinding } from '../src/types.js';

const claim = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  severity: 'blocker',
  summary: 'the test file was weakened',
  file: 'src/a.test.ts',
  claim: 'file_changed',
  ...over,
});

describe('normalizeClaimPath', () => {
  it('strips the decorations a model writes around a path', () => {
    expect(normalizeClaimPath('`src/a.ts`')).toBe('src/a.ts');
    expect(normalizeClaimPath('"src/a.ts"')).toBe('src/a.ts');
    expect(normalizeClaimPath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeClaimPath('  src/a.ts  ')).toBe('src/a.ts');
  });

  it('strips the a/ and b/ prefixes of the diff it was reading', () => {
    expect(normalizeClaimPath('b/src/a.ts')).toBe('src/a.ts');
  });

  it('drops a line, and a line:column, reference', () => {
    expect(normalizeClaimPath('src/a.ts:42')).toBe('src/a.ts');
    expect(normalizeClaimPath('src/a.ts:42:9')).toBe('src/a.ts');
  });

  it('normalizes windows separators, since git never uses them', () => {
    expect(normalizeClaimPath('src\\a.ts')).toBe('src/a.ts');
  });
});

describe('pathsMatch', () => {
  it('matches identical paths, case-insensitively', () => {
    expect(pathsMatch('src/a.ts', 'src/a.ts')).toBe(true);
    expect(pathsMatch('SRC/A.ts', 'src/a.ts')).toBe(true);
  });

  // The reviewer writes prose paths. None of these is a lie about the diff,
  // and treating them as one would discard real findings.
  it('matches when one path is a suffix of the other', () => {
    expect(pathsMatch('home/you/repo/src/a.ts', 'src/a.ts')).toBe(true);
    expect(pathsMatch('a.ts', 'src/a.ts')).toBe(true);
  });

  it('matches a bare filename against the file anywhere in the tree', () => {
    expect(pathsMatch('a.test.ts', 'packages/core/a.test.ts')).toBe(true);
  });

  it('matches a directory claim against anything under it', () => {
    expect(pathsMatch('tests/', 'tests/unit/a.ts')).toBe(true);
    expect(pathsMatch('tests/', 'src/tests/a.ts')).toBe(true);
    expect(pathsMatch('tests/', 'src/a.ts')).toBe(false);
  });

  it('does not match a different file', () => {
    expect(pathsMatch('src/a.ts', 'src/b.ts')).toBe(false);
  });

  // Suffix matching on a boundary, not on characters: `b.ts` must not be
  // rescued by `lib.ts` ending with those bytes.
  it('does not match on a partial filename', () => {
    expect(pathsMatch('b.ts', 'lib.ts')).toBe(false);
  });
});

describe('checkClaim', () => {
  it('supports a claim about a file the diff really touches', () => {
    const check = checkClaim(claim(), ['src/a.test.ts', 'src/a.ts']);
    expect(check.status).toBe('supported');
  });

  // The observed failure: a blocker reporting that a test file had been
  // weakened, when git showed it untouched. It cost the task both attempts.
  it('refutes a claim about a file the diff never touched', () => {
    const check = checkClaim(claim(), ['src/a.ts']);
    expect(check.status).toBe('unsupported');
    expect(check.reason).toContain('src/a.test.ts');
  });

  it('leaves a finding alone when the reviewer did not claim a change', () => {
    const check = checkClaim(claim({ claim: 'other' }), ['src/a.ts']);
    expect(check.status).toBe('unverifiable');
  });

  // A finding about a missing change necessarily names a file outside the
  // diff. Dropping those would be the check doing exactly what it exists to
  // prevent — discarding a real finding on a name lookup.
  it('never refutes an unclassified finding, however specific it is', () => {
    const unlabelled = claim({ claim: undefined, file: 'src/never-touched.ts' });
    expect(checkClaim(unlabelled, ['src/a.ts']).status).toBe('unverifiable');
  });

  it('cannot refute a claim that names no file', () => {
    expect(checkClaim(claim({ file: undefined }), ['src/a.ts']).status).toBe('unverifiable');
    expect(checkClaim(claim({ file: '   ' }), ['src/a.ts']).status).toBe('unverifiable');
  });
});

describe('checkFindings', () => {
  const findings: ReviewFinding[] = [
    claim({ summary: 'invented', file: 'src/ghost.test.ts' }),
    claim({ summary: 'real', file: 'src/a.ts' }),
    claim({ summary: 'behavioural', claim: 'other', file: 'src/ghost.ts' }),
  ];

  it('splits the refuted findings out of the ones still eligible to block', () => {
    const checked = checkFindings(findings, ['src/a.ts']);
    expect(checked.discarded.map((f) => f.summary)).toEqual(['invented']);
    expect(checked.standing.map((f) => f.summary)).toEqual(['real', 'behavioural']);
  });

  it('keeps every finding, verdict attached, so nothing vanishes from the record', () => {
    const checked = checkFindings(findings, ['src/a.ts']);
    expect(checked.all).toHaveLength(3);
    expect(checked.all.map((f) => f.check?.status)).toEqual([
      'unsupported',
      'supported',
      'unverifiable',
    ]);
  });

  it('does not mutate the findings it was given', () => {
    checkFindings(findings, ['src/a.ts']);
    expect(findings[0]?.check).toBeUndefined();
  });
});
