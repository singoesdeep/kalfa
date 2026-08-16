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
                  reviewer reads the diff          (codex)
                       ↓ no blocking findings
                  commit, next task

                  anything red? feed the failure back verbatim, retry
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
leaves an accurate board:

```markdown
2/5 done · 1 blocked · 2 pending · $3.4120

| # | Task | Status | Attempts | Commit | Cost |
|---|---|---|---|---|---|
| 1 | `[x]` T1: Add a token-bucket limiter | done | 1 | `a1b2c3d4` | $0.4210 |
| 2 | `[!]` T2: Wire it into the dispatcher | blocked | 3 | — | $1.8800 |
| 3 | `[ ]` T3: Document the config keys | pending | 0 | — | — |

## Needs you

### T2: Wire it into the dispatcher
- **Reason:** no attempt passed verification in 3 attempts
- **Last attempt:** gate `test` failed
- **Abandoned work:** parked in stash `deadbeef` — `git stash apply`
```

`kalfa status` prints the same thing to the terminal, and `--json` gives you
the raw record. Watch a run from a second terminal with either.

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
| `.kalfa/state.json` | task status, attempts, cost | `--run-id` resume |
| `.kalfa/journal.jsonl` | every event, including each task's final report | you |
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
kalfa init                              # writes kalfa.yaml + a plan template
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
| `kalfa init [--force]` | Write starter `kalfa.yaml` and `kalfa.plan.json` |
| `kalfa spec "<goal>"` | Inspect the repo, ask its questions once, write `docs/PRD.md` + `docs/SPEC.md` |
| `kalfa plan [goal]` | Write a validated plan. The goal is optional once a SPEC exists |
| `kalfa status [--json]` | Where the current run got to. No API calls |
| `kalfa plan --no-interview` | Generate straight from the goal, asking nothing |
| `kalfa plan --print-prompt` | Print the planning prompt and exit. No API call |
| `kalfa validate` | Check config and plan, print execution order. No API calls |
| `kalfa run` | Run the plan unattended |
| `kalfa run --dry-run` | Print the execution order and exit |
| `kalfa run --run-id <id>` | Resume a run; tasks already `done` are skipped |
| `kalfa contract` | Print the autonomy contract handed to every agent |

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
  abort_after_consecutive_blocks: 3
  # max_run_cost_usd: 25.0
```

Gates run in declaration order and the first required failure stops the rest —
a type error makes test output noise, and the worker is better served by one
real error than a cascade. Mark slow or flaky checks `required: false` to have
them reported without forcing a retry.

## Known limitations

- **Codex cost is not reported at all.** The `codex exec` CLI does not print
  per-run cost, and Kalfa will not invent a number from a local price table.
  Every total is therefore the builder's spend only. Kalfa marks such totals
  with a trailing `+` and says so in `TASKS.md`, in `kalfa status` and at the
  end of a run — including the warning that `max_run_cost_usd` is enforced
  against that floor, so real spend can exceed the ceiling you set.
- **Tasks run one at a time.** Independent tasks could run in parallel; they
  don't yet. Wall-clock is the sum of the plan.
- **No quality measurement.** The gates prove the code compiles, passes tests
  and survives review. Nothing measures whether the result is *good*. That
  judgement is still yours — which is what the morning diff is for.
- **The reviewer produces false positives, and one is enough to block a task.**
  Observed live: it reported as a blocker that a test file had been modified
  when git showed it untouched, which cost the task both its attempts. A
  single reviewer opinion is treated as authoritative, with no second vote and
  no way for the builder to win an argument. When gates are green and only the
  review blocks, BLOCKED.md now records the finding, the worker'''s answer to
  it, and where the work is parked — so you can adjudicate rather than guess.
- **Nothing detects a genuine oscillation.** Every retry is now told what all
  its predecessors failed on — one line each, under `Already tried and
  failed` — so a worker can recognise a loop. Whether it acts on that is up to
  the model; Kalfa does not detect repetition itself and will happily spend
  all three attempts on it.
- **The ADR index still grows**, just far more slowly than a single log would.
  On a very long plan it is still a rising per-task cost, and nothing prunes
  or scopes it to the task at hand.
- **Nothing verifies that an agent actually recorded its decisions.** The
  contract requires it and the reviewer can notice its absence, but a task can
  pass every gate having quietly assumed something and written nothing down.
- **The reviewer sees the diff, not the plan's history.** It cannot tell you a
  task was solved in a way that will make task 7 impossible.
- **An unparseable review blocks the task.** A reviewer that cannot be read is
  never treated as a pass, which means reviewer flakiness costs you tasks.
- **The planner is never re-consulted.** If the plan turns out to be wrong at
  task 4, no agent revises it — task 4 is attempted as written, and blocks if
  it cannot be done. Replanning is your job, in the morning.
- **`kalfa plan` validates structure, not judgement.** It checks that ids
  resolve, dependencies exist and there are no cycles. Nothing checks that the
  tasks are the right tasks.

## Development

```bash
npm test         # 150 tests, no API calls
npm run typecheck
npm run build
```

The runner tests drive a real git repository in a temp directory with the
agents stubbed. Git behaviour — commit per task, stash on failure, a clean tree
between tasks — is the part most worth testing, and mocking it would test
nothing.

## License

MIT
