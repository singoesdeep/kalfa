import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADR_DIR,
  adrInstructions,
  nextAdrNumber,
  parseAdr,
  readAdrs,
  refreshAdrIndex,
  renderAdrIndex,
} from '../src/adr/adr.js';

let dir: string;

const writeAdr = (name: string, body: string): void =>
  writeFileSync(join(dir, ADR_DIR, name), body, 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kalfa-adr-'));
  mkdirSync(join(dir, ADR_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseAdr', () => {
  it('reads number, title, status and task from a well-formed record', () => {
    const entry = parseAdr(
      '0003-use-token-bucket.md',
      `# 0003. Use a token bucket for rate limiting\n\n- **Status:** accepted\n- **Task:** T2\n`,
    );
    expect(entry).toEqual({
      number: 3,
      title: 'Use a token bucket for rate limiting',
      status: 'accepted',
      task: 'T2',
      file: '0003-use-token-bucket.md',
    });
  });

  it('falls back to the filename when the heading is missing', () => {
    const entry = parseAdr('0007-some-choice.md', 'no heading here');
    expect(entry?.title).toBe('some choice');
    expect(entry?.status).toBe('unknown');
  });

  it('ignores files that are not numbered records', () => {
    expect(parseAdr('README.md', '# Index')).toBeUndefined();
    expect(parseAdr('notes.md', '# Notes')).toBeUndefined();
  });
});

describe('readAdrs / nextAdrNumber', () => {
  it('starts at 1 in an empty project', () => {
    expect(nextAdrNumber(dir)).toBe(1);
  });

  it('sorts records by number and continues after the highest', () => {
    writeAdr('0002-b.md', '# 0002. B\n\n- **Status:** accepted\n');
    writeAdr('0001-a.md', '# 0001. A\n\n- **Status:** accepted\n');
    writeAdr('0010-c.md', '# 0010. C\n\n- **Status:** accepted\n');

    expect(readAdrs(dir).map((a) => a.number)).toEqual([1, 2, 10]);
    // Continues past the highest rather than filling the gap, so numbers are
    // never reused and links in older records stay valid.
    expect(nextAdrNumber(dir)).toBe(11);
  });

  it('never counts the index itself as a record', () => {
    refreshAdrIndex(dir);
    expect(readAdrs(dir)).toHaveLength(0);
    expect(nextAdrNumber(dir)).toBe(1);
  });
});

describe('refreshAdrIndex', () => {
  it('regenerates the index from the files on disk', () => {
    writeAdr('0001-first.md', '# 0001. First choice\n\n- **Status:** accepted\n- **Task:** T1\n');
    writeAdr('0002-second.md', '# 0002. Second choice\n\n- **Status:** superseded by 0003\n');

    refreshAdrIndex(dir);
    const index = readFileSync(join(dir, ADR_DIR, 'README.md'), 'utf8');

    expect(index).toContain('First choice');
    expect(index).toContain('superseded by 0003');
    expect(index).toContain('[0001](./0001-first.md)');
  });

  it('is idempotent, so it can run after every task', () => {
    writeAdr('0001-a.md', '# 0001. A\n\n- **Status:** accepted\n');
    refreshAdrIndex(dir);
    const once = readFileSync(join(dir, ADR_DIR, 'README.md'), 'utf8');
    refreshAdrIndex(dir);
    expect(readFileSync(join(dir, ADR_DIR, 'README.md'), 'utf8')).toBe(once);
  });

  it('creates the directory when the project has none', () => {
    const bare = mkdtempSync(join(tmpdir(), 'kalfa-bare-'));
    try {
      expect(refreshAdrIndex(bare)).toEqual([]);
      expect(readFileSync(join(bare, ADR_DIR, 'README.md'), 'utf8')).toContain(
        'No decisions recorded yet',
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('renderAdrIndex', () => {
  it('explains superseding rather than inviting edits to accepted records', () => {
    const text = renderAdrIndex([]);
    expect(text).toMatch(/Do not edit an accepted record/);
    expect(text).toMatch(/superseded by NNNN/);
  });
});

describe('adrInstructions', () => {
  it('hands the worker the exact next filename, so it never has to look', () => {
    const text = adrInstructions(7, 'T3');
    expect(text).toContain('0007-<short-kebab-slug>.md');
    expect(text).toContain('# 0007.');
    expect(text).toContain('**Task:** T3');
  });

  it('gives the following number for a second decision in the same task', () => {
    expect(adrInstructions(7, 'T3')).toContain('use `0008`');
  });

  it('tells the worker not to touch the index, which Kalfa owns', () => {
    expect(adrInstructions(1, 'T1')).toMatch(/Do not update the index/);
  });

  it('draws the line at architectural decisions, not naming', () => {
    const text = adrInstructions(1, 'T1');
    expect(text).toMatch(/Do NOT write a record for naming, formatting/);
  });

  it('requires the downsides, not just the benefits', () => {
    expect(adrInstructions(1, 'T1')).toMatch(/honest about the downsides/);
  });
});
