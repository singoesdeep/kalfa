# Kalfa

**An unattended build runner. One agent writes, a different one reviews, machines approve.**

Kalfa takes a frozen plan and works through it while you are not there. It never
asks you a question. When it hits an ambiguity it makes the conventional choice,
writes down what it assumed, and keeps going.

---

## The problem

Spec-driven frameworks are good at producing a plan and bad at letting you
leave. They stop at every phase boundary to confirm, clarify and check in —
because a human approval gate is the cheapest available quality mechanism. The
result is a tool that plans your project and then chains you to the keyboard
while it builds it.

Kalfa makes the opposite trade:

| | Interactive frameworks | Kalfa |
|---|---|---|
| Ambiguity | stops and asks you | assumes, files an ADR, continues |
| Quality gate | your review | test/typecheck gates + a second vendor's model |
| Your review | synchronous, per phase | asynchronous, once, in the morning |
| Stops for | anything unclear | only irreversible actions |

You still review everything. You just do it after, from a diff and a set of
decision records, instead of during, one question at a time.

## How it works

```
plan.json  ──►  for each task, in dependency order:

                  builder writes the code          (claude)
                       ↓
                  gates run                        (typecheck, tests, lint…)
                       ↓ green
                  did it touch a test?             → flag it, tell the reviewer
                       ↓                             to verify, not to weigh
                  reviewer reads the diff          (codex)
                       ↓
                  does the diff support its        → no? discard the finding,
                  claims about what changed?         say so, do not block
                       ↓ no blocking findings
                  commit, next task

                  anything red? feed the failure back verbatim, retry
                  last attempt, still blocked? ask the reviewer once more
                  out of attempts? stash it, log it, KEEP GOING
```

Every branch of that loop ends in "keep going". Kalfa stops the whole run only
for a cost ceiling, repeated blocks, or Ctrl-C.

## The documents

Kalfa keeps the artifacts a team would keep, because an unattended agent needs
them for the same reason a new hire does — and it cannot ask.

```
docs/PRD.md        why we are building this, for whom, what success means
  ↓
docs/SPEC.md       what exactly gets built — behaviour, contracts, NON-GOALS
  ↓
kalfa.plan.json    how — ordered, dependency-aware tasks
  ↓
TASKS.md           where it got to          (regenerated every status change)
docs/adr/          why each choice was made (one file per decision)
BLOCKED.md         what needs a human
```

Each level is generated from the one above and is the input to the one below.
`kalfa spec` writes the top two, `kalfa plan` writes the third, `kalfa run`
produces the bottom row.

**Non-goals earn their own mention.** The characteristic failure of an
unattended agent is not doing too little, it is doing too much — adding
caching nobody asked for, generalising a function used once. A written list of
what is out of scope is the only thing the reviewer can hold a diff against.
`kalfa spec` refuses to write a SPEC without one.

### Decision records, not a decision log

Every task is told to read the prior decisions before it starts. That makes a
single append-only file the wrong shape: it costs more to read on every task,
until eventually a task reads it partially or skips it — silently, and exactly
on the long runs where the earlier context matters most.

So each decision is its own file, `docs/adr/0007-use-a-token-bucket.md`, in
the usual Context / Decision / Consequences / Alternatives form. Tasks read
`docs/adr/README.md`, which is one line per decision and stays small, then
open only the records that bear on their work.

**Agents write the records; Kalfa regenerates the index** by scanning the
directory after every task. Nothing depends on an agent remembering to update
two files, and the index cannot drift from what is on disk.

An accepted record is never edited to change its decision — a later record
supersedes it and says so. The history of what was believed when is the point.

### The board

`TASKS.md` is rewritten on every status change, so a run killed at 3am still
leaves an accurate board. This is a real one, from a run that fixed a pricing
bug and was asked to add a regression case:

```markdown
# Tasks

**Goal:** Fix the order total and cover the zero-quantity case

**Run:** `20260816-054955` · branch `kalfa/20260816-054955`
**Finished:** 2026-08-16T02:51:06.306Z

1/1 done · $0.1609+

> Costs are a FLOOR, not a total: the codex CLI does not report per-run
> cost, so the reviewer's spend is missing from every figure here.

| # | Task | Status | Attempts | Commit | Cost |
|---|---|---|---|---|---|
| 1 | `[x]` T1: Fix the discount calculation and add a regression case | done | 1 | `0da41eeb` | $0.1609 |

## Tests and checks were modified

These tasks changed files that are supposed to be judging the work.
That is sometimes right and sometimes how a bad change gets through.
Read these diffs first.

### T1: Fix the discount calculation and add a regression case

- `check.mjs`

`git show 0da41eeb`
```

A blocked task also gets a **Needs you** section naming what stopped it, what
the last attempt failed on, and the stash its abandoned work is parked in.

`kalfa status` prints the same information to the terminal, and `--json` gives
you the raw record. Either works from a second terminal while a run is going.

```
run 20260816-054955  branch kalfa/20260816-054955  finished
Fix the order total and cover the zero-quantity case

  [x] T1  done      0da41eeb  [tests modified]  Fix the discount calculation …

1/1 done  ·  $0.1609+
cost is a floor — codex does not report its spend

1 task(s) modified tests or checks — read those diffs first:
  T1  check.mjs
```

## Memory, and why context never fills

Every task runs in a **fresh session**. Nothing is resumed, nothing carries
over in conversation. Task 12 starts as empty as task 1.

That is the point. A long run cannot exhaust its context window, because
context is scoped to one task attempt rather than to the run. The unit that
can overflow is a single task — and if one does, `max_turns` catches it.

The cost is that **each task is amnesiac**, so memory has to live on disk:

| Artifact | Holds | Read by |
|---|---|---|
| git commits | the code, one commit per task | every later task |
| `docs/adr/` | every decision made instead of asking, one file each | every later task, and you |
| `TASKS.md` | the board: status, attempts, commits, cost | you, mid-run |
| `BLOCKED.md` | what it would not do, and why | you |
| `.kalfa/state.json` | task status, attempts, cost, schema version | `--run-id` resume |
| `.kalfa/journal.jsonl` | every event: phases, commands, decisions | you, `status --watch`, your tooling |
| `.kalfa/runs/<id>/artifacts/` | per attempt: transcripts, gate output, diffs, findings | you, when a summary is not enough |
| `kalfa.plan.json` | the plan | the run |

So each task prompt hands over what the session cannot: which tasks already
landed, an instruction to read `docs/adr/README.md` first, and a pointer to
`git log` for anything else. A retry is told to run `git diff HEAD` before
touching anything — its own previous attempt is in the working tree, and that
diff is the only record of it.

**If a task runs out of turns or context, it is not treated as done.**
`claude -p` exits zero when it aborts that way — the process succeeded, the
task didn't — so Kalfa checks the result subtype, not the exit code. An
aborted attempt is a failed attempt: it retries, and if it never finishes, the
work is stashed rather than committed.

To pick up an interrupted run:

```bash
kalfa run --run-id 20260816-031500    # completed tasks are skipped
```

Resuming across a Kalfa upgrade is safe. `.kalfa/state.json` carries a
`schemaVersion` and is validated on every read, the same way the config and the
plan are. State written by an older Kalfa is migrated in place — with a
timestamped `.bak` of the original kept beside it — and state written by a
*newer* Kalfa is refused rather than misread. Nothing malformed is ever
silently treated as a fresh run, because a fresh run redoes work you have
already paid for. `kalfa doctor` reports which case you are in before a resume
spends anything:

```
run state    run 20260816-031500 · schema v1
             8/13 task(s) done, unfinished
             resume it: kalfa run --run-id 20260816-031500
```

## Why two vendors

The builder cannot grade its own homework — not because it lies, but because
whatever misunderstanding produced the bug also produces the self-assessment. A
different vendor's model, reading only the diff, does not share that
misunderstanding.

`kalfa validate` warns when builder and reviewer are the same provider. It will
still run; it just tells you the review is worth less than you think.

The reviewer is specifically instructed to hunt for *cheating* — deleted tests,
weakened assertions, disabled checks, functions stubbed to return constants —
because that is the failure mode of an agent under pressure to make a gate pass.

**What live runs actually showed.** Twice, on unrelated tasks, the reviewer
caught a real defect the builder had missed and the gates could not see.

On a money-splitting task, floating-point arithmetic broke the exact-sum
guarantee near `Number.MIN_SAFE_INTEGER`; it gave a counterexample, suggested
BigInt, and asked for a regression case. On a currency parser asked to
round-trip everything its formatter could produce, it noticed that
`Number.prototype.toFixed` switches to exponential notation above 1e21 — so
`formatCents(1e24)` returns `"$1e+22"`, which the parser threw on. The gates
were green both times, because the tests exercised the ordinary range.

That is the claim working: a second vendor finding a correctness bug in the
obscure part of the input space, not offering a style opinion.

The second of those runs is also the best evidence for the rest of the
machinery, because it ended in a block. The retry fixed the exponential-
notation gap and the reviewer immediately found a deeper one: `formatCents`
divides by 100 in floating point, so `formatCents(9007199254540993)` loses a
cent and nothing can round-trip it — inside the safe-integer range. Gates
green, second opinion asked and confirmed, task blocked, work stashed.

`BLOCKED.md` then carried the finding, the fact that the gates had passed, the
worker's own account of what it did, and the stash to recover from. Verifying
the claim took one `node -e` and about a minute, and the conclusion was that
the reviewer was right and the *plan* was wrong: an acceptance criterion had
demanded a round-trip that float division cannot provide. That is the intended
shape of the morning — adjudicating a specific claim, not reconstructing a
night.

It also showed the limit. Given a test suite that was mathematically
impossible to satisfy, the builder relaxed an assertion and wrote a decision
record containing a correct impossibility proof. The reviewer read the
rationale and passed it **without checking the proof**. That call happened to
be right. The risk it exposes is not "the builder deletes assertions" — under
several deliberately adversarial framings the builder never once took the
cheap way out. It is that **a test-weakening diff arrived with a persuasive
argument attached, and the argument was accepted rather than verified.** A
fabricated rationale would look identical from the reviewer'''s seat.

Which is why that particular check is not left to the reviewer alone — see
below.

### Protected paths

Kalfa cannot judge whether a given test change is legitimate; that needs
knowledge and stakes only you have. What it can do is make sure the change is
never quiet.

Any task whose diff touches `policy.protected_paths` (tests, specs, `check.*`,
by default) gets three things:

1. the reviewer is handed the file list with an instruction to **verify a
   justification rather than weigh it**, and told in as many words that a
   convincing explanation for weakening a test is what a wrong change looks
   like;
2. the paths are recorded on the task;
3. `TASKS.md` grows a **Tests and checks were modified** section, above
   "Needs you", with the `git show` command for each.

Mechanical detection, human judgement. Set `protected_paths: []` to switch it
off.

### Claims git can settle

The reviewer is the only judgement in the pipeline that nothing checks, and the
cost of that showed up in the worst possible shape. Asked to review a *correct*
fix, reviewers twice reported as a blocker that a test file had been weakened —
when `git diff HEAD --name-only` did not list the file at all. Correct work was
thrown away over a change that never happened.

A blocking finding is a claim about a diff, and some of those claims the diff
itself can settle. So every finding now carries a label the reviewer sets:

| `claim` | Means | Checked? |
|---|---|---|
| `file_changed` | "this diff did something to `file`" — modified, added, deleted, weakened | yes |
| `other` | a change that is *missing*, a caller not updated, anything about behaviour | no |

A `file_changed` finding whose path is not in the pending change list is
**discarded**: it never blocks, never costs an attempt, and never reaches the
retry prompt. No agent runs, nothing is re-asked, nothing is spent — it is a
name lookup against the list Kalfa already computed for protected paths.

The check is deliberately narrow, and the bias throughout is towards letting a
finding stand:

- only `file_changed` is checkable at all, because "you forgot to update
  `src/other.ts`" necessarily names a file outside the diff and must survive;
- an unlabelled finding is never discarded;
- path matching is lenient — absolute paths, `a/`/`b/` prefixes, `:42` line
  references, a bare filename and a directory all match. Only a name that
  matches nothing is treated as evidence of anything;
- an unrecognised label degrades to `other` rather than failing the payload,
  because an unparseable review blocks the task.

Discarding is never silent. The run log prints the finding and why it was
dropped, the journal records it as `review_claims_discarded`,
`review.findings.json` keeps every finding with its verdict attached, and
`TASKS.md` grows a **Review findings the diff did not support** section. That
last one matters most on a task that then *passed* — nothing else in the
morning would tell you the reviewer made a claim about a file it never saw.

Set `verify_review_claims: false` to switch it off and give the reviewer the
last word again.

## Requirements

- Node 20+
- A git repository with at least one commit, and a clean working tree
- [`claude`](https://claude.com/claude-code) and [`codex`](https://github.com/openai/codex)
  CLIs installed and logged in

Kalfa shells out to both CLIs rather than importing an SDK, so it uses whatever
credentials you already have and does not pin you to an SDK version.

## Install

```bash
git clone <this repo> && cd kalfa
npm install && npm run build
npm link            # optional: puts `kalfa` on your PATH
```

## Use

```bash
cd your-project
kalfa doctor                            # is this repo and machine ready?
kalfa init                              # kalfa.yaml, a plan template, the agent skill
kalfa spec "add rate limiting to the webhook dispatcher"   # PRD + SPEC
kalfa plan                              # tasks, from the spec
kalfa validate                          # checks config + plan, execution order
kalfa run                               # go to bed
```

In the morning:

```bash
kalfa status               # where it got to
cat TASKS.md               # the board, with what needs you
cat docs/adr/README.md     # every decision it made instead of asking
cat BLOCKED.md             # what it refused to do, and why
git log --oneline          # one commit per task
kalfa run --run-id <id>    # resume: finished tasks are skipped
```

| Command | What it does |
|---|---|
| `kalfa doctor` | Check this repo and machine are ready. Runs nothing, spends nothing |
| `kalfa init [--force]` | Write starter `kalfa.yaml`, `kalfa.plan.json`, and the agent skill |
| `kalfa spec "<goal>"` | Inspect the repo, ask its questions once, write `docs/PRD.md` + `docs/SPEC.md` |
| `kalfa plan [goal]` | Write a validated plan. The goal is optional once a SPEC exists |
| `kalfa status [--json]` | Where the current run got to. No API calls |
| `kalfa status --watch` | Follow a running build until it ends, then exit with what happened |
| `kalfa plan --no-interview` | Generate straight from the goal, asking nothing |
| `kalfa plan --print-prompt` | Print the planning prompt and exit. No API call |
| `kalfa validate` | Check config and plan, print execution order. No API calls |
| `kalfa run` | Run the plan unattended |
| `kalfa run --dry-run` | Print the execution order and exit |
| `kalfa run --run-id <id>` | Resume a run; tasks already `done` are skipped |
| `kalfa run --new` | Start fresh even though an earlier run was interrupted |
| `kalfa run --force` | Take the run lock even if another run appears to hold it |
| `kalfa run --verbose` | Print every command, tool call and gate line as it happens |
| `kalfa run --jsonl` | Emit the structured event stream on stdout; prose moves to stderr |
| `kalfa contract` | Print the autonomy contract handed to every agent |

## Watching a run you are not sitting in front of

A run is launched detached and outlives the terminal that started it. Two ways
to keep track, both of which read local files and spend nothing:

```bash
kalfa status --watch        # follow transitions, exit when the run ends
kalfa status --watch --json # the same, as raw events, for tooling
```

The exit code is the report:

| Code | Meaning |
|---|---|
| `0` | finished, every task done |
| `2` | finished, but something is blocked or skipped |
| `3` | the run stopped without finishing — killed, crashed, or rebooted |
| `1` | there was nothing to watch |

That last one matters more than it looks: a watcher that waits forever for an
event that will never arrive is worse than no watcher.

If you would rather be told than watch, give Kalfa one command:

```yaml
notify:
  command: 'notify-send "kalfa: $KALFA_EVENT" "$KALFA_DONE done, $KALFA_BLOCKED blocked"'
  on: [completed, blocked, failed]
```

It runs once, at the end, with the run summary as JSON on stdin and the
headline numbers in `KALFA_*`. Kalfa deliberately ships no Slack client, no
SMTP and no toast: one command and a JSON payload is enough to build any of
them in three lines, and keeps Kalfa out of the business of maintaining them.
The hook cannot change the run's outcome — it fires after the last commit, a
failure is reported and never propagated, and it is killed if it hangs.

### When a summary is not enough

Every line a run prints is short, and each one names the file behind it. Under
`.kalfa/runs/<run-id>/artifacts/<task>/<attempt>/`:

| File | What it holds |
|---|---|
| `builder.stdout.log` | everything the worker's CLI printed, written as it arrived |
| `builder.tools.jsonl` | every tool call it made — which file, which command |
| `builder.report.md` | its final message |
| `gates/<name>.stdout.log`, `.stderr.log` | each gate's full output, per stream, untrimmed |
| `diff.patch`, `diff.stat.txt` | the diff the reviewer was actually shown |
| `review.findings.json` | its complete findings, every severity, each with git's verdict on its claim |
| `review.raw.txt` | its untruncated response — including when it could not be parsed |
| `decision.json` | what the attempt concluded, why, and which files prove it |

This is what makes a blocking finding checkable rather than merely reported. A
reviewer once blocked a task claiming a test file had been modified when git
showed it untouched; adjudicating that in the morning means having the diff it
was looking at, not a paragraph about it.

Streams are written synchronously as they arrive, so a builder that hangs or
takes the process down with it still leaves everything it printed up to that
moment on disk.

Turn the whole thing off with `kalfa run --no-artifacts`, or
`observability.artifacts: false`.

### What is redacted

Anything Kalfa writes — artifacts, the journal, `BLOCKED.md` — is filtered
first: the values of this process's secret-looking environment variables
(`*_TOKEN`, `*_KEY`, `*_SECRET`, …), the well-known credential shapes, and
whatever you add to `observability.redact_patterns`. It is a safety net rather
than a guarantee, and it is biased towards over-redacting.

Prompts are **not** captured by default. They embed task details and whatever
the planner learned about your repository, and artifacts are meant to be
pasted into issues; set `observability.capture_prompts: true` to keep them.

No hidden model reasoning is ever recorded.

## Driving it from Claude Code or Codex

You do not have to type those commands. `kalfa init` also writes a skill:

```
.claude/skills/kalfa/SKILL.md     # Claude Code
.agents/skills/kalfa/SKILL.md     # Codex CLI
```

Ask either agent to build something with kalfa and it takes the operator's
seat: checks `doctor`, writes the spec, shows you the Non-goals and the plan's
`details` fields, launches the run detached, and reads `TASKS.md`,
`BLOCKED.md` and the ADRs back to you when it finishes.

**The skill is per-project, not installed into your home directory.** A skill
that offers an unattended build runner in a repository with no `kalfa.yaml`,
no gates and no plan is worse than no skill. Commit the two files and a
teammate's agent finds them too. Re-run `kalfa init` after upgrading kalfa to
pick up a newer skill; it will not overwrite your `kalfa.yaml` without
`--force`.

The skill exists mostly to stop three things an agent otherwise does:

- **triggering the interview.** `spec` and `plan` ask their questions on
  stdin. No agent can answer that, so it hangs. The skill always passes
  `--no-interview` and does the interview itself, in chat — which is a better
  interview, because it can read your repository while asking.
- **blocking on `kalfa run`.** A run outlives any agent's command timeout. The
  skill launches it detached and polls `kalfa status --json`.
- **writing the feature itself.** Which is the one thing it must not do.

## Is it ready?

`kalfa doctor` answers that before you spend anything. It runs nothing of
yours — no gates are executed, no prompts are sent, no money is spent — and
every check in it exists because something actually went wrong here first:

```
  ok    git repo    /home/you/project
  ok    commits     ed16ea7d on main
  ok    clean tree  clean
  ok    claude CLI  2.1.227 (Claude Code)
  ok    codex CLI   codex-cli 0.146.0
  ok    config      /home/you/project/kalfa.yaml
                    builder   claude (sonnet)
                    reviewer  codex
                    gates     typecheck, test
  ok    agents      no advisory warnings
  ok    plan        4 tasks
  ok    plan gates  all task gate references resolve
  ok    gate check  npm  /usr/local/bin/npm

10 ok

ready — nothing here would stop `kalfa run`.
```

A failure carries its remedy on the next line rather than at the end of the
report, and the command exits non-zero so it can gate a script.

Most of `doctor` was written by Kalfa itself, unattended, from a spec that
`kalfa spec` generated — including the Windows PATHEXT handling in its
executable resolution, which is the sort of detail that gets skipped by hand.

## Planning: the one sitting

`kalfa plan "<goal>"` reads your repository, asks **every question it has at
once**, and writes a validated plan.

```
$ kalfa plan "add rate limiting to the webhook dispatcher"
reading the repository...

3 questions. Press Enter to accept the suggested answer.
This is the only time you will be asked.

1. Should the limit be per-tenant or global?
   why: per-tenant needs a keyed bucket store, which is a separate task
   [per-tenant, keyed on the existing tenant_id] >

2. Reject over-limit requests, or queue them?
   [reject with 429 and Retry-After] > queue up to 100, then reject

...
writing the plan...

wrote kalfa.plan.json — 5 tasks, $0.4120
```

The batching is the point. Interactive frameworks ask one question at a time,
across phases, over hours — that is what chains you to the keyboard. Kalfa
asks everything in one sitting and then never asks again. The planner is
required to supply a real suggested answer for every question, so pressing
Enter through all of them is a legitimate way to use it.

The planner runs with `Edit`, `Write` and `MultiEdit` denied at the CLI level.
It reads your repository; it cannot start the work before you have seen the plan.

**A plan that does not validate is never written.** Generation runs a repair
loop: schema errors (unknown dependency, cycle, duplicate id) are fed back
verbatim and it tries again, up to three times, then fails loudly. An invalid
plan discovered at 3am costs you the whole night.

## The plan format

The plan is the contract between the one interactive session you sit through
and every unattended run that follows.

```json
{
  "version": 1,
  "goal": "Add rate limiting to the webhook dispatcher",
  "tasks": [
    {
      "id": "T1",
      "title": "Add a token-bucket limiter",
      "details": "Write it as if the worker has never seen this plan and cannot ask you anything.",
      "deps": [],
      "files": ["src/limit.ts"],
      "acceptance": [
        "Requests over the configured rate get HTTP 429",
        "The limit is read from config, not hardcoded"
      ]
    }
  ]
}
```

**Vagueness here becomes a decision an agent makes alone.** That is the deal —
it is not a bug, but it does mean the quality of your morning is decided by the
quality of your `details` and `acceptance` fields. Write acceptance criteria a
test can assert, not ones a human must judge.

Which is why the plan is worth reading before you run it, even when `kalfa
plan` wrote it. Reading a generated plan takes five minutes; a bad plan costs
you a night.

### What a wrong dependency costs

`deps` is the cheapest field in the plan to write and the most expensive to be
wrong about. A blocked task skips every task that declares a dependency on it,
whether or not the dependency was real — so an edge the planner invented turns
one failure into three.

It invents them. On a six-task run the planner produced a strictly linear
chain, every task depending on exactly its predecessor, including a
documentation task that depended on the CLI task before it. Task 4 failed and
tasks 5 and 6 were skipped for a dependency neither of them had.

Nothing can tell a real edge from an invented one — that needs to know what the
code does. So `kalfa plan` and `kalfa validate` do the part that is mechanical:
they put the shape of the graph, and what each task's failure would take down
with it, in front of you before anything runs.

```
  tasks     4, execution order:
     1. T1: token bucket   [3 skipped if it blocks]
     2. T2: wire into dispatcher  <- T1   [2 skipped if it blocks]
     3. T3: config surface  <- T2   [1 skipped if it blocks]
     4. T4: document it  <- T3
  warning:  this plan is a strict linear chain — every task depends on exactly
            the one before it. Planners produce that shape by default and it is
            rarely the real graph. It also has no slack: the first task to block
            takes every task after it down with it, needed or not.
            Read each `deps` and delete the ones that are not real.
```

Three things, in decreasing order of confidence:

- **The blast radius**, per task, always. Exact and not a judgement: it is the
  count of transitive dependents.
- **A strict linear chain**, when the whole plan is one. That is the planner's
  default output and almost never the real graph. Only reported at three tasks
  or more, because with two "the second needs the first" is ordinary.
- **Dependencies between tasks that share no declared `files`.** Weak on its
  own — a task can import what an earlier one wrote without touching its files
  — but it is where an invented edge shows up. Suppressed under a chain
  warning, which has already said to check every edge, and bounded to five so
  it stays readable.

None of this fails a plan. Deleting an edge you do not need is a one-line edit
now and a wasted night later.

## The autonomy contract

Every agent gets the same preamble. `kalfa contract` prints it in full; the
part that matters:

> **NEVER ask a question.** No clarifying questions, no confirmations, no
> "would you like me to". Any sentence ending in a question mark is a failure
> of this task.
>
> **On ambiguity:** pick the most conventional option consistent with the
> surrounding codebase, then file an ADR recording what you assumed, why,
> what you rejected, and how expensive it is to reverse. Recording the decision
> IS the approval process.
>
> **Stop only for irreversible actions:** spending money, writing to
> production, deleting data you cannot reconstruct, force-pushing, publishing,
> or a credential you do not have. Ambiguous requirements are NOT blockers.

That last line is the whole design. Every framework that locks you to the
keyboard does so by treating ambiguity as a blocker.

## Safety

What Kalfa can do: edit files in your repo, run your configured gate commands,
commit to a branch it created, and `git stash`.

What it never does: push, force-push, rewrite history, touch a remote, or
delete a stash. Nothing it does is unrecoverable through git.

- **Preflight refuses to start** on a dirty tree, so its work is always
  distinguishable from yours.
- **A new branch per run** (`kalfa/<run-id>`), unless you set
  `use_current_branch`.
- **One commit per task**, so a failure at task 9 never loses tasks 1–8.
- **Failed work is stashed**, not left in the tree, so the next task does not
  build on a broken base. It is fully recoverable — `git stash list`.
- **`.kalfa/` ignores itself** from within, so run state is never committed to
  your history and never swept up by a stash.
- **`max_run_cost_usd`** stops the run before the next task when hit.
- **An interrupted run is not silently repeated.** `kalfa run` refuses to
  start a new run while an earlier one never finished, and tells you the id to
  resume — starting over would redo work you have already paid for. Resuming
  is also allowed to find a dirty tree, because that dirt is the interrupted
  task's own half-finished work.
- **One run at a time per repository.** A lock file records the pid; a second
  run refuses to start rather than interleaving commits and clobbering state
  with the first. A lock whose process is gone is treated as stale and taken
  over, so a crash never blocks the next run.

## Configuration

See `kalfa.yaml` from `kalfa init`. The parts worth thinking about:

```yaml
policy:
  max_attempts: 3             # per task, including the first
  blocking_severity: major    # which review findings force a retry
  verify_review_claims: true  # check a finding against the diff before it may block
  abort_after_consecutive_blocks: 3
  # max_run_cost_usd: 25.0
```

Gates run in declaration order and the first required failure stops the rest —
a type error makes test output noise, and the worker is better served by one
real error than a cascade. Mark slow or flaky checks `required: false` to have
them reported without forcing a retry.

```yaml
observability:
  artifacts: true             # per-attempt transcripts, gate output, diffs, findings
  capture_prompts: false      # prompts embed repo content; opt in
  redact_patterns: []         # extra regexes masked out of everything written

notify:
  command: null               # one shell command; run summary as JSON on stdin
  on: [completed, blocked, failed]
  timeout_ms: 30000
```

## Known limitations

- **Codex cost is not reported at all.** The `codex exec` CLI does not print
  per-run cost, and Kalfa will not invent a number from a local price table.
  Every total is therefore the builder's spend only. Kalfa marks such totals
  with a trailing `+` and says so in `TASKS.md`, in `kalfa status` and at the
  end of a run — including the warning that `max_run_cost_usd` is enforced
  against that floor, so real spend can exceed the ceiling you set.
- **Tasks run one at a time.** Independent tasks could run in parallel; they
  don't yet. Wall-clock is the sum of the plan.
- **Artifacts are never pruned.** A long run keeps every attempt's transcript,
  gate output and diff under `.kalfa/runs/`, and nothing deletes them. They
  are git-ignored, so they cost disk rather than history — but on a large plan
  that is real disk. `kalfa run --no-artifacts` turns it off wholesale; there
  is no retention policy in between.
- **Redaction is a filter, not a guarantee.** It masks the values of
  secret-looking environment variables and the well-known credential shapes,
  chunk by chunk as output arrives — which means a secret split across a chunk
  boundary can slip through. Read an artifact before you paste it somewhere
  public.
- **No quality measurement.** The gates prove the code compiles, passes tests
  and survives review. Nothing measures whether the result is *good*. That
  judgement is still yours — which is what the morning diff is for.
- **The reviewer still produces false positives that nothing can settle.**
  The one class git can refute — a claim that this diff changed a file it did
  not touch — is now checked before a finding may block anything (see
  *Claims git can settle*). Everything else is a judgement: a bug that is not
  a bug, a convention that is not a convention. There is no second vote for
  those except on the final attempt, and no way for the builder to win an
  argument. When gates are green and only the review blocks, BLOCKED.md records
  the finding, the worker'''s answer to it, where the work is parked, and the
  attempt directory holding the reviewer'''s complete response and the diff it
  was shown — so you can adjudicate against the evidence rather than guess.
- **Only the claude provider reports tool-level activity.** `claude -p` is run
  with `--output-format stream-json`, so every tool call the builder makes is
  an event you can watch. `codex exec` reports nothing comparable, so a codex
  reviewer is a silent four minutes with only its command line, pid, stdout
  artifact and last-output time to go on. Kalfa says so rather than leaving
  the silence to be read as a hang.
- **An attempt is only counted once it finishes.** A run killed mid-builder
  leaves that attempt out of the task's record, so the board can show one
  fewer attempt than really happened. The journal records every attempt on
  entry, so `.kalfa/journal.jsonl` has the truth even when the board does not.
- **`max_attempts` resets on resume.** A task that had used two of three
  attempts before an interruption gets three more. That is usually what you
  want — you resumed for a reason — but it means the setting bounds a run
  rather than a task.
- **Nothing detects a genuine oscillation.** Every retry is now told what all
  its predecessors failed on — one line each, under `Already tried and
  failed` — so a worker can recognise a loop. Whether it acts on that is up to
  the model; Kalfa does not detect repetition itself and will happily spend
  all three attempts on it.
- **The ADR index still grows**, just far more slowly than a single log would.
  On a very long plan it is still a rising per-task cost, and nothing prunes
  or scopes it to the task at hand.
- **Nothing verifies that an agent actually recorded its decisions.** The
  contract requires it, but a task can pass every gate having quietly assumed
  something and written nothing down. Kalfa counts the records each task
  produces and `TASKS.md` says plainly when a run completed tasks and recorded
  nothing — which is the right outcome if the spec left nothing open, and
  indistinguishable from the wrong one. A live two-task run did exactly this.
- **The reviewer knows what is coming but not what happened.** It is given the
  titles of the tasks still to come, so it can flag a change that paints one of
  them into a corner — but it still sees only the current diff, not how the
  earlier tasks were solved.
- **An unparseable review blocks the task.** A reviewer that cannot be read is
  never treated as a pass, which means reviewer flakiness costs you tasks.
- **The planner is never re-consulted.** If the plan turns out to be wrong at
  task 4, no agent revises it — task 4 is attempted as written, and blocks if
  it cannot be done. Replanning is your job, in the morning.
- **`kalfa plan` validates structure, not judgement.** It checks that ids
  resolve, dependencies exist and there are no cycles. Nothing checks that the
  tasks are the right tasks.
- **The planner still invents dependencies; nothing can tell that it has.**
  On a six-task run it produced a strictly linear chain — every task depending
  on exactly its predecessor, including a documentation task that depended on
  the CLI task before it. The prompt tells it not to do this. It did it anyway,
  and the cost was real: when task 4 failed, tasks 5 and 6 were skipped for a
  dependency neither of them needed. `plan` and `validate` now report the shape
  and what it would cost (see *What a wrong dependency costs*), but that is a
  prompt to read, not a check — telling a real edge from an invented one needs
  to know what the code does.
- **Tasks that block cascade further than they should**, for the same reason.
  A skipped task is skipped on its declared dependency, and a declared
  dependency that is not a real one turns one failure into three. Kalfa prints
  the blast radius per task before the run; it does not second-guess it during
  one.

## Development

```bash
npm test         # 220 tests, no API calls
npm run typecheck
npm run build
```

The runner tests drive a real git repository in a temp directory with the
agents stubbed. Git behaviour — commit per task, stash on failure, a clean tree
between tasks — is the part most worth testing, and mocking it would test
nothing.

## License

MIT
