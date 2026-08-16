/**
 * Protected paths — the files a task should not normally be rewriting.
 *
 * This exists because of a specific observed failure. Given a test suite that
 * was mathematically impossible to satisfy, the builder relaxed an assertion,
 * wrote a decision record containing a correct impossibility proof, and the
 * reviewer passed it. That particular call was defensible. The problem is what
 * it reveals: the reviewer accepted a *rationale* it had not independently
 * checked, and a builder that fabricates a plausible rationale for weakening a
 * test looks identical from the reviewer's seat.
 *
 * Kalfa cannot judge whether a given test change is legitimate — that needs
 * the domain knowledge and the stake that only the human has. What it can do
 * is guarantee the change is never quiet: flag it to the reviewer with an
 * explicit instruction to verify rather than accept, and put it on the board
 * so it is the first thing read in the morning.
 *
 * A mechanical detector, not an opinion.
 */

export const DEFAULT_PROTECTED_PATHS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/check.*',
  '**/conftest.py',
];

/**
 * Translate a glob into a regex.
 *
 * Deliberately small: `**` crosses directory separators, `*` and `?` do not,
 * everything else is literal. A dependency for this would be a dependency to
 * audit, and the pattern set is short and known.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` should also match zero directories, so `**/x` matches `x`.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // Paths from git are posix-style and repo-relative; match the whole path.
  return new RegExp(`^${out}$`, 'i');
}

export function isProtected(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/\\/g, '/');
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

export function protectedAmong(paths: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  return paths.filter((path) => isProtected(path, patterns));
}

/**
 * The block appended to the review prompt when a task touches protected files.
 *
 * Worded to counter the observed failure mode specifically: the reviewer's
 * mistake was accepting an argument, not missing a diff. So it is told to
 * verify the claim, and told that a convincing explanation is not evidence.
 */
export function protectedPathsCallout(paths: string[]): string {
  return [
    ``,
    `## This diff modifies protected files`,
    ``,
    ...paths.map((p) => `- \`${p}\``),
    ``,
    `These are tests or checks — the things that are supposed to be judging the`,
    `work, not moving with it. Treat every change to them as suspect until you`,
    `have checked it yourself:`,
    ``,
    `1. Read the actual change. Was an assertion removed, loosened, skipped, or`,
    `   its tolerance widened? Quote the before and after.`,
    `2. If the worker justified it — in the diff, in a decision record, or in a`,
    `   comment — **verify the justification independently**. Do not accept it`,
    `   because it is well argued. A convincing explanation for weakening a test`,
    `   is exactly what a wrong change looks like, and reviewers have been`,
    `   talked into passing one before.`,
    `3. A test changed to match the implementation, rather than the`,
    `   implementation changed to match the test, is a blocker unless the test`,
    `   was demonstrably wrong — and "demonstrably" means you followed the`,
    `   reasoning and it held, not that it sounded right.`,
    ``,
    `Legitimate reasons exist: a new test for new behaviour, a test that encoded`,
    `a bug, an interface that genuinely changed. Say which one applies and how`,
    `you confirmed it.`,
  ].join('\n');
}
