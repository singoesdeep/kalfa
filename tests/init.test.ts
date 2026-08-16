import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { STARTER_FILES, writeStarterFiles } from '../src/config/init.js';
import { AGENT_SKILL } from '../src/config/templates.js';

describe('writeStarterFiles', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'kalfa-init-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('writes every starter file, creating nested skill directories', () => {
    const result = writeStarterFiles(cwd);

    expect(result.every((f) => f.written)).toBe(true);
    for (const [rel] of STARTER_FILES) {
      expect(readFileSync(resolve(cwd, rel), 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('installs the same skill for both agent CLIs', () => {
    writeStarterFiles(cwd);

    for (const rel of ['.claude/skills/kalfa/SKILL.md', '.agents/skills/kalfa/SKILL.md']) {
      expect(readFileSync(resolve(cwd, rel), 'utf8')).toBe(AGENT_SKILL);
    }
  });

  // `init` is what people re-run to pick up a newer skill after upgrading
  // kalfa. Resetting their edited kalfa.yaml as a side effect of that would
  // silently undo the config the whole run depends on.
  it('leaves existing files alone without --force', () => {
    writeFileSync(resolve(cwd, 'kalfa.yaml'), 'mine\n', 'utf8');

    const result = writeStarterFiles(cwd);

    expect(result.find((f) => f.path === 'kalfa.yaml')?.written).toBe(false);
    expect(readFileSync(resolve(cwd, 'kalfa.yaml'), 'utf8')).toBe('mine\n');
    // the ones that did not exist are still written
    expect(result.find((f) => f.path === '.agents/skills/kalfa/SKILL.md')?.written).toBe(true);
  });

  it('overwrites with force, including a stale skill', () => {
    mkdirSync(resolve(cwd, '.claude/skills/kalfa'), { recursive: true });
    writeFileSync(resolve(cwd, '.claude/skills/kalfa/SKILL.md'), 'old skill\n', 'utf8');

    writeStarterFiles(cwd, true);

    expect(readFileSync(resolve(cwd, '.claude/skills/kalfa/SKILL.md'), 'utf8')).toBe(AGENT_SKILL);
  });
});

describe('AGENT_SKILL', () => {
  // Both CLIs discover a skill by parsing this frontmatter; a skill whose
  // name or description does not survive templating is silently never loaded.
  it('opens with name and description frontmatter', () => {
    const [, frontmatter] = AGENT_SKILL.split('---\n');
    expect(AGENT_SKILL.startsWith('---\n')).toBe(true);
    expect(frontmatter).toMatch(/^name: kalfa$/m);
    expect(frontmatter).toMatch(/^description: .+/m);
  });

  it('tells the agent the two things that hang or waste a run', () => {
    expect(AGENT_SKILL).toContain('--no-interview');
    expect(AGENT_SKILL).toContain('detached');
  });
});
