import type { ClaimCheck, ReviewFinding } from '../types.js';

/**
 * Checking a review finding against git before it is allowed to block a task.
 *
 * The reviewer is the only judgement in the pipeline that nothing checks. That
 * showed up in practice in the worst possible shape: asked to review a correct
 * fix, reviewers twice reported as a blocker that a test file had been
 * weakened, when `git diff HEAD --name-only` did not list the file at all. A
 * fabricated blocker is not a bad opinion — it is a claim about the diff that
 * the diff refutes, and it cost a task both of its attempts.
 *
 * So a finding that asserts something about what the diff *did* is checked
 * against what the diff actually contains. No agent, no second call, no cost:
 * a name lookup against the pending change list.
 *
 * The check is deliberately narrow. It can only refute one kind of claim —
 * "this diff changed X" when X was never touched. Everything else, including
 * every finding about a change that is *missing*, is untouchable by a name
 * lookup and passes through unexamined. That is why the reviewer labels its
 * own findings (see `ReviewClaim`): Kalfa does not guess which claims are
 * mechanical, it is told, and it checks only those.
 *
 * The bias throughout is towards letting a finding stand. Discarding a real
 * blocker is a bug that ships; keeping a fabricated one costs an attempt.
 */

/** Strip a reviewer-written path down to something comparable with git's. */
export function normalizeClaimPath(raw: string): string {
  return (
    raw
      .trim()
      // Models quote paths in backticks as often as not.
      .replace(/^[`'"]+|[`'"]+$/g, '')
      .replace(/\\/g, '/')
      // `src/a.ts:42` and `src/a.ts:42:9` — the location, not the name.
      .replace(/:\d+(?::\d+)?$/, '')
      // The a/ and b/ prefixes of the diff it was reading.
      .replace(/^[ab]\//, '')
      .replace(/^\.\//, '')
      // An absolute path is left as a long suffix; the match below handles it.
      .replace(/^\/+/, '')
      .trim()
  );
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Does a reviewer-written path refer to this changed file?
 *
 * Lenient on purpose. The reviewer writes prose paths — absolute, relative to
 * a subdirectory, sometimes just a filename — and none of that is a lie about
 * the diff. Only a name that matches nothing at all is evidence of anything.
 */
export function pathsMatch(claimPath: string, changedPath: string): boolean {
  const claim = claimPath.toLowerCase();
  const changed = changedPath.replace(/\\/g, '/').toLowerCase();
  if (claim.length === 0) return false;

  // A directory, e.g. "tests/": anything under it counts.
  if (claim.endsWith('/')) return changed.startsWith(claim) || changed.includes(`/${claim}`);

  if (claim === changed) return true;
  if (claim.endsWith(`/${changed}`) || changed.endsWith(`/${claim}`)) return true;
  return basename(claim) === basename(changed);
}

/**
 * Judge one finding against the files this diff actually touches.
 *
 * `unverifiable` is the normal answer and not a criticism: most findings are
 * about behaviour, and git has nothing to say about those.
 */
export function checkClaim(finding: ReviewFinding, changedFiles: string[]): ClaimCheck {
  if (finding.claim !== 'file_changed') {
    return { status: 'unverifiable' };
  }
  if (!finding.file || finding.file.trim().length === 0) {
    // It says the diff changed something and does not say what. There is
    // nothing to look up, so there is nothing to refute.
    return { status: 'unverifiable', reason: 'claims a change but names no file' };
  }

  const claimPath = normalizeClaimPath(finding.file);
  if (claimPath.length === 0) return { status: 'unverifiable' };

  const hit = changedFiles.find((changed) => pathsMatch(claimPath, changed));
  if (hit) return { status: 'supported', reason: `${hit} is in the diff` };

  return {
    status: 'unsupported',
    reason:
      `claims this diff changed \`${finding.file}\`, but git shows it untouched ` +
      `(${changedFiles.length} file(s) changed)`,
  };
}

export interface CheckedFindings {
  /** Every finding, each carrying its verdict. */
  all: ReviewFinding[];
  /** The ones git refutes. Reported, never enforced. */
  discarded: ReviewFinding[];
  /** The ones still eligible to block. */
  standing: ReviewFinding[];
}

export function checkFindings(findings: ReviewFinding[], changedFiles: string[]): CheckedFindings {
  const all = findings.map((finding) => ({ ...finding, check: checkClaim(finding, changedFiles) }));
  return {
    all,
    discarded: all.filter((f) => f.check?.status === 'unsupported'),
    standing: all.filter((f) => f.check?.status !== 'unsupported'),
  };
}

/** One line per discarded finding, for the run log and the board. */
export function formatDiscarded(findings: ReviewFinding[]): string[] {
  return findings.map((f) => {
    const summary = f.summary.replace(/\s+/g, ' ');
    return `[${f.severity}] ${summary.length > 90 ? `${summary.slice(0, 90)}…` : summary} — ${
      f.check?.reason ?? 'unsupported by the diff'
    }`;
  });
}
