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
