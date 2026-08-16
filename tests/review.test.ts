import { describe, expect, it } from 'vitest';
import { blockingFindings, formatFindings, parseReviewPayload } from '../src/review/review.js';
import { REVIEW_OUTPUT_SCHEMA } from '../src/prompts/contract.js';
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

  // Strict structured output requires every property in `required`, so
  // optional fields come back as explicit nulls rather than being absent.
  // A live run 400d and retried for ten minutes before this was right.
  it('normalizes the explicit nulls the output schema forces', () => {
    const findings = parseReviewPayload(
      '{"findings":[{"severity":"major","summary":"boom","file":null,"line":null,"suggestion":null}]}',
    );
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.file).toBeUndefined();
    expect(findings?.[0]?.line).toBeUndefined();
    expect(findings?.[0]?.suggestion).toBeUndefined();
  });

  it('still accepts fields that are genuinely present', () => {
    const findings = parseReviewPayload(
      '{"findings":[{"severity":"blocker","summary":"x","file":"a.ts","line":4,"suggestion":"fix"}]}',
    );
    expect(findings?.[0]?.file).toBe('a.ts');
    expect(findings?.[0]?.line).toBe(4);
  });
});

describe('REVIEW_OUTPUT_SCHEMA', () => {
  it('lists every property as required, which strict mode demands', () => {
    const item = REVIEW_OUTPUT_SCHEMA.properties.findings.items;
    expect([...item.required].sort()).toEqual(
      Object.keys(item.properties).sort(),
    );
  });

  it('expresses optionality as a nullable type instead', () => {
    const props = REVIEW_OUTPUT_SCHEMA.properties.findings.items.properties;
    expect(props.file.type).toEqual(['string', 'null']);
    expect(props.line.type).toEqual(['integer', 'null']);
    expect(props.summary.type).toBe('string');
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
