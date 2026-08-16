/** Starter files written by `kalfa init`. Kept as strings so they ship in dist. */

export const EXAMPLE_CONFIG = `# kalfa.yaml — the operating envelope for an unattended run.
#
# The single most important property of this file: builder and reviewer should
# be DIFFERENT vendors. A model reviewing its own output shares whatever
# misunderstanding produced the bug.

agents:
  builder:
    provider: claude
    model: sonnet             # alias or full model id; omit for the CLI default
    # bypassPermissions, not acceptEdits: acceptEdits auto-approves edits but
    # NOT Bash, so an unattended builder stops and asks before it can run your
    # tests — and reports success while leaving the work unverified.
    permission_mode: bypassPermissions
    max_turns: 60
    timeout_ms: 1800000       # 30 min per attempt

  reviewer:
    provider: codex
    sandbox: read-only        # the reviewer reads the diff; it must not edit
    timeout_ms: 900000
    # If you use claude as the reviewer instead, deny the write tools — a
    # reviewer that can edit becomes a second builder and quietly "fixes"
    # what it should be reporting:
    # disallowed_tools: [Edit, Write, MultiEdit, NotebookEdit]

# Gates are what replaces your approval. They must be deterministic and
# non-interactive — anything that opens a pager or reads stdin will hang.
# Order matters: the first required failure stops the rest, so put the fastest
# and most fundamental check first.
gates:
  - name: typecheck
    run: npm run typecheck
  - name: test
    run: npm test
  # - name: lint
  #   run: npm run lint
  #   required: false         # reported and fed back, but does not force a retry

policy:
  max_attempts: 3             # attempts per task, including the first
  review: true
  blocking_severity: major    # blocker | major | minor

  # On the final attempt a blocking finding does not cost a retry, it costs
  # the work — everything gets stashed. Reviewers are not oracles (one was
  # observed inventing a blocker, then withdrawing it when asked again with
  # nothing changed), so re-ask once before throwing the work away.
  review_second_opinion: true

  # Files a task should not normally be rewriting. Touching one is not
  # forbidden — it is reported: the reviewer is told to verify the
  # justification rather than accept it, and TASKS.md grows a section naming
  # the change so you see it in the morning. Set to [] to disable.
  protected_paths:
    - "**/*.test.*"
    - "**/*.spec.*"
    - "**/test/**"
    - "**/tests/**"
    - "**/__tests__/**"
    - "**/check.*"
  commit_per_task: true       # one commit per task, so failure never loses work
  branch: kalfa/{run_id}
  use_current_branch: false
  stash_failed_work: true     # park abandoned work; recover with \`git stash list\`
  abort_after_consecutive_blocks: 3
  # max_run_cost_usd: 25.0    # hard ceiling for the whole run
`;

export const EXAMPLE_PLAN = `{
  "version": 1,
  "goal": "Replace this with the one-sentence outcome of the whole run.",
  "tasks": [
    {
      "id": "T1",
      "title": "A small, self-contained first task",
      "details": "Everything the worker needs, written as if it has never seen this plan and cannot ask you anything. Name the files, the conventions, and the edge cases you care about. Vagueness here becomes an assumption recorded as an ADR.",
      "deps": [],
      "files": ["src/example.ts"],
      "acceptance": [
        "State each condition so a reviewer can check it against the diff",
        "Prefer conditions a test can assert over conditions a human must judge"
      ]
    },
    {
      "id": "T2",
      "title": "A task that builds on the first",
      "details": "Tasks run in dependency order, one at a time, each on top of the previous commit.",
      "deps": ["T1"],
      "acceptance": ["..."]
    }
  ]
}
`;

/**
 * The skill that lets a coding agent drive kalfa instead of the user doing it
 * by hand: "kalfa ile şunu yap" in Claude Code or Codex, rather than six
 * commands in a terminal.
 *
 * It is written into the project, not installed globally, because it is only
 * correct where a kalfa.yaml is — a skill offering an unattended runner in a
 * repo that has no config, no gates and no plan is worse than no skill.
 *
 * The three things it exists to prevent, all of which a naive agent does:
 *   - triggering the stdin interview, which no agent can answer, so it hangs;
 *   - blocking on `kalfa run`, which outlives any command timeout;
 *   - writing the feature itself, which is the one thing it must not do.
 */
export const AGENT_SKILL = `---
name: kalfa
description: Run an unattended, gate-driven build with the \`kalfa\` CLI — one agent writes, a second vendor reviews, machines approve. Use when the user wants a feature or fix built end-to-end without sitting at the keyboard, when they say "kalfa", "unattended", or "run it overnight", or when a goal is large enough to want a spec, a plan, per-task commits and decision records instead of a single interactive edit session.
---

# Kalfa — driving the unattended build runner

You are the operator, not the builder. Kalfa spawns its own builder (\`claude -p\`)
and reviewer (\`codex\`) for every task. Your job is to turn the user's prompt
into a spec and a plan they approve, launch the run, and report what came back.

**Do not write the feature yourself while this skill is active.** If the user
wanted you to write it, they would not have asked for kalfa.

## Preconditions — check before anything else

\`\`\`
kalfa doctor
\`\`\`

It runs nothing of yours, sends no prompts, spends nothing, and exits non-zero
if this repo or machine is not ready. Do not work around a failure it reports —
fix the cause it names, or tell the user. The usual ones:

- **\`kalfa\` not on PATH** — run \`npm link\` once in the kalfa checkout, or call
  \`node <path-to-kalfa>/dist/cli/main.js\` instead.
- **dirty tree** — kalfa refuses to start so it can tell its work from yours.
  Commit or stash *your* edits first, including the \`kalfa.yaml\` and
  \`kalfa.plan.json\` you just generated, and tell the user you did.
- **no commits** — the repository needs an initial commit.
- **missing \`claude\` or \`codex\`** — both CLIs must be installed and logged in.
  Kalfa shells out to them; there is no SDK fallback.

If you are running inside a sandboxed agent, kalfa needs to spawn those CLIs
and reach the network. If \`doctor\` passes but the builder fails immediately,
that is the sandbox — say so and let the user widen it. Do not try to defeat it.

## You replace the interview — never trigger it

\`kalfa spec\` and \`kalfa plan\` stop and ask the user questions on stdin. You
cannot answer those and neither can a piped shell, so **always pass
\`--no-interview\`**. Do the interview yourself instead, in chat, where you can
also read the repository:

1. Read enough of the codebase to know what the goal touches.
2. Ask the user *every* open question in one message — the same batching kalfa
   would do. Give each one a suggested answer they can simply accept.
3. Fold the answers into a detailed goal of a sentence or two. That is the only
   input the planner gets, and a vague goal becomes an assumption nobody will
   be awake to catch.

## The sequence

\`\`\`bash
kalfa doctor                              # ready?
kalfa spec "<goal, with the answers folded in>" --no-interview
#   -> writes docs/PRD.md and docs/SPEC.md
kalfa plan --no-interview                 # reads SPEC.md, writes kalfa.plan.json
kalfa validate                            # config + plan + execution order
kalfa run                                 # the long one — see below
\`\`\`

**Stop and show the user the spec and the plan before running.** Two things
matter, and both are cheap to fix now and expensive to fix at 3am:

- **The Non-goals section of \`docs/SPEC.md\`.** It is the only thing the
  reviewer can hold a diff against. If it is thin, the run builds things nobody
  asked for.
- **Each task's \`details\` in \`kalfa.plan.json\`.** Every vague field becomes an
  assumption recorded as an ADR. Read them back to the user.

Edit those files directly if the user wants changes, then re-run
\`kalfa validate\`. Regenerate with \`--force\` if the change is large.

Do not launch \`kalfa run\` without explicit approval. It spends real money on
two vendors' models and it writes commits.

## Launching the run

A run takes hours and will outlive your command timeout, so **launch it
detached and poll**. Do not block on it.

\`\`\`bash
nohup kalfa run > .kalfa/run.log 2>&1 &
\`\`\`

\`\`\`powershell
Start-Process kalfa -ArgumentList 'run' -NoNewWindow \`
  -RedirectStandardOutput .kalfa\\run.log -RedirectStandardError .kalfa\\run.err
\`\`\`

Then watch with commands that cost nothing and make no API calls:

\`\`\`bash
kalfa status            # the board
kalfa status --json     # the raw record
tail .kalfa/run.log
\`\`\`

Kalfa holds one lock per working tree. Never start a second run beside a live
one, and do not reach for \`--force\` to take the lock unless the user confirms
the other run is genuinely dead.

Exit codes: \`0\` finished clean, \`2\` finished with blocked or skipped tasks,
\`1\` something failed before the run started.

## Reporting back

When it ends, read these and summarise. Do not paste them.

| File | What you are looking for |
|---|---|
| \`TASKS.md\` | the board — read its "Tests and checks were modified" section first |
| \`BLOCKED.md\` | what it would not do, the reviewer's finding, the stash to recover from |
| \`docs/adr/README.md\` | every decision it made instead of asking |
| \`git log --oneline\` | one commit per task, on the run's branch |

Lead with what needs the user:

1. **Blocked tasks.** State the reviewer's specific claim and whether you
   verified it. A block is usually a real finding — the reviewer has caught
   correctness bugs the gates could not see. It is also sometimes a wrong
   *plan* rather than wrong code. Say which you think it is, and why.
2. **Protected-path touches.** Any task that changed tests, specs or checks. A
   convincing rationale for weakening a test is exactly what a bad change looks
   like, so read those diffs and verify the argument rather than weighing it.
3. **Assumptions** the user may disagree with, from the ADRs.
4. Cost, noting that it is a **floor**: the codex CLI does not report per-run
   spend, so the reviewer's cost is missing from every figure kalfa prints.

## Resuming

An interrupted or partly blocked run resumes, skipping finished tasks:

\`\`\`bash
kalfa run --run-id <id>
\`\`\`

Kalfa refuses a bare \`kalfa run\` while an unfinished run exists, because
starting fresh silently redoes work already paid for. Pass \`--new\` only when
the user says to throw the previous run away.

A resume is allowed to start with a dirty tree — the interrupted task's work is
in there on purpose, and its retry prompt tells the worker to go and read it.
Do not clean it up first.

## Configuration worth checking

In \`kalfa.yaml\`, before the first run in a repository:

- **builder and reviewer should be different vendors.** \`validate\` warns when
  they are not; a model is a weak reviewer of its own output.
- **gates** — a typecheck and tests at minimum. With no gates, nothing verifies
  the work but the reviewer.
- **builder \`permission_mode\`** — \`acceptEdits\` auto-approves edits but *not*
  Bash, so unattended it stops and asks before it can run your tests, and
  reports that as a finished task. Use \`bypassPermissions\`, or list \`Bash\` in
  \`allowed_tools\`.
- **\`policy.protected_paths\`** — leave it on. It is the mechanical half of the
  test-tampering check, and the reviewer alone is not enough.

\`kalfa contract\` prints the autonomy contract every agent is handed, if you
need to explain to the user why kalfa did something instead of asking.
`;

