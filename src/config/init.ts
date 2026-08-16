import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AGENT_SKILL, EXAMPLE_CONFIG, EXAMPLE_PLAN } from './templates.js';

/**
 * What `kalfa init` puts in a repository, in the order it reports them.
 *
 * The agent skill is written per-project rather than into the user's home
 * directory, and once per agent CLI rather than symlinked from one copy: a
 * symlink checked into a repository does not survive Windows or a tarball, and
 * these files are meant to be committed so a teammate's agent finds them too.
 */
export const STARTER_FILES: ReadonlyArray<readonly [string, string]> = [
  ['kalfa.yaml', EXAMPLE_CONFIG],
  ['kalfa.plan.json', EXAMPLE_PLAN],
  ['.claude/skills/kalfa/SKILL.md', AGENT_SKILL],
  ['.agents/skills/kalfa/SKILL.md', AGENT_SKILL],
];

export interface StarterFile {
  /** Repo-relative, forward-slashed — what gets printed. */
  path: string;
  written: boolean;
}

/**
 * Never overwrite without `force`: `init` is the command people re-run to get
 * the skill after upgrading kalfa, and an edited kalfa.yaml is the last thing
 * that should be silently reset when they do.
 */
export function writeStarterFiles(cwd: string, force = false): StarterFile[] {
  return STARTER_FILES.map(([rel, content]) => {
    const path = resolve(cwd, rel);
    if (existsSync(path) && !force) return { path: rel, written: false };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    return { path: rel, written: true };
  });
}
