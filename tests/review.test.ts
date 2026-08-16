import { describe, expect, it } from 'vitest';
import { blockingFindings, formatFindings, parseReviewPayload } from '../src/review/review.js';
import type { ReviewFinding } from '../src/types.js';

describe('parseReviewPayload', () => {
  it('parses clean JSON', () => {
    const findings = parseReviewPayload('{"findings":[{"severity":"major","summary":"off by one"}]}');
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.severity).toBe('major');
  });

  it('parses JSON wrapped in a fenced code block', () => {
    const text = 'Here is my review:\n```json\n{"findings":[]}\n```\nHope that helps.';
    expect(parseReviewPayload(text)).toEqual([]);
  });

  it('parses JSON surrounded by prose without fences', () => {
    const text = 'I reviewed it. {"findings":[{"severity":"blocker","summary":"deleted a test"}]} Done.';
    expect(parseReviewPayload(text)?.[0]?.severity).toBe('blocker');
  });

  it('returns undefined for unparseable output rather than an empty pass', () => {
    expect(parseReviewPayload('Looks good to me!')).toBeUndefined();
  });

  it('rejects a payload with an invalid severity', () => {
    expect(parseReviewPayload('{"findings":[{"severity":"critical","summary":"x"}]}')).toBeUndefined();
  });
});

describe('blockingFindings', () => {
  const findings: ReviewFinding[] = [
    { severity: 'minor', summary: 'naming' },
    { severity: 'major', summary: 'race condition' },
    { severity: 'blocker', summary: 'test deleted' },
  ];

  it('blocks at or above the threshold', () => {
    expect(blockingFindings(findings, 'major').map((f) => f.severity)).toEqual(['major', 'blocker']);
  });

  it('blocks only blockers at the loosest threshold', () => {
    expect(blockingFindings(findings, 'blocker').map((f) => f.severity)).toEqual(['blocker']);
  });

  it('blocks everything at the strictest threshold', () => {
    expect(blockingFindings(findings, 'minor')).toHaveLength(3);
  });
});

describe('formatFindings', () => {
  it('puts the worst finding first, since retries may not address them all', () => {
    const text = formatFindings([
      { severity: 'minor', summary: 'naming' },
      { severity: 'blocker', summary: 'test deleted' },
    ]);
    expect(text.indexOf('[blocker]')).toBeLessThan(text.indexOf('[minor]'));
  });

  it('includes file and line when the reviewer gave them', () => {
    const text = formatFindings([
      { severity: 'major', summary: 'boom', file: 'src/a.ts', line: 42 },
    ]);
    expect(text).toContain('(src/a.ts:42)');
  });
});
