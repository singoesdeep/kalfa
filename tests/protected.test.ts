import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROTECTED_PATHS,
  globToRegExp,
  isProtected,
  protectedAmong,
  protectedPathsCallout,
} from '../src/gates/protected.js';

/**
 * The failure this guards against, observed live: handed a test suite that was
 * mathematically impossible to satisfy, the builder relaxed an assertion and
 * wrote a decision record containing a correct impossibility proof. The
 * reviewer read the rationale and passed it without checking the claim.
 *
 * That call was defensible. What it reveals is not: a builder that fabricates
 * a plausible rationale for weakening a test looks identical from the
 * reviewer's seat. So detection is mechanical, and the human always hears
 * about it.
 */

describe('globToRegExp', () => {
  it('matches a plain filename', () => {
    expect(globToRegExp('check.mjs').test('check.mjs')).toBe(true);
    expect(globToRegExp('check.mjs').test('src/check.mjs')).toBe(false);
  });

  it('lets * stay within one path segment', () => {
    const re = globToRegExp('src/*.ts');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/nested/a.ts')).toBe(false);
  });

  it('lets ** cross directories, and match none of them', () => {
    const re = globToRegExp('**/*.test.ts');
    expect(re.test('a.test.ts')).toBe(true);
    expect(re.test('src/a.test.ts')).toBe(true);
    expect(re.test('src/deep/nested/a.test.ts')).toBe(true);
    expect(re.test('src/a.ts')).toBe(false);
  });

  it('treats dots as literals rather than wildcards', () => {
    expect(globToRegExp('a.test.ts').test('axtestxts')).toBe(false);
  });
});

describe('isProtected', () => {
  it('recognises the usual test layouts out of the box', () => {
    for (const path of [
      'src/thing.test.ts',
      'src/thing.spec.js',
      'test/helpers.py',
      'tests/integration/api.rb',
      'src/__tests__/thing.tsx',
      'check.mjs',
    ]) {
      expect(isProtected(path, DEFAULT_PROTECTED_PATHS), path).toBe(true);
    }
  });

  it('leaves ordinary source alone', () => {
    for (const path of ['src/index.ts', 'README.md', 'src/testing-utils.ts', 'contest.js']) {
      expect(isProtected(path, DEFAULT_PROTECTED_PATHS), path).toBe(false);
    }
  });

  it('normalises Windows separators, since git and the OS disagree', () => {
    expect(isProtected('src\\__tests__\\a.ts', DEFAULT_PROTECTED_PATHS)).toBe(true);
  });

  it('matches nothing when the feature is switched off', () => {
    expect(protectedAmong(['src/a.test.ts'], [])).toEqual([]);
  });
});

describe('protectedAmong', () => {
  it('returns only the protected files, preserving order', () => {
    const changed = ['src/a.ts', 'src/a.test.ts', 'README.md', 'tests/b.js'];
    expect(protectedAmong(changed, DEFAULT_PROTECTED_PATHS)).toEqual([
      'src/a.test.ts',
      'tests/b.js',
    ]);
  });
});

describe('protectedPathsCallout', () => {
  const callout = protectedPathsCallout(['src/a.test.ts']);

  it('names the files so the reviewer cannot miss them', () => {
    expect(callout).toContain('src/a.test.ts');
  });

  it('tells the reviewer to verify a justification, not weigh it', () => {
    expect(callout).toMatch(/verify the justification independently/);
    expect(callout).toMatch(/Do not accept it\s+because it is well argued/);
  });

  it('names the exact trap: a convincing argument for a bad change', () => {
    expect(callout).toMatch(
      /convincing explanation for weakening a test\s+is exactly what a wrong change looks like/,
    );
  });

  it('asks for the before and after to be quoted, not summarised', () => {
    expect(callout).toMatch(/Quote the before and after/);
  });

  it('still allows legitimate test changes, and says which they are', () => {
    expect(callout).toMatch(/Legitimate reasons exist/);
    expect(callout).toMatch(/a test that encoded\s+a bug/);
  });
});
