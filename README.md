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
| Ambiguity | stops and asks you | assumes, logs to `DECISIONS.md`, continues |
| Quality gate | your review | test/typecheck gates + a second vendor's model |
| Your review | synchronous, per phase | asynchronous, once, in the morning |
| Stops for | anything unclear | only irreversible actions |

You still review everything. You just do it after, from a diff and a decision
log, instead of during, one question at a time.

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
| `DECISIONS.md` | every assumption made instead of asking | every later task, and you |
| `BLOCKED.md` | what it would not do, and why | you |
| `.kalfa/state.json` | task status, attempts, cost | `--run-id` resume |
| `.kalfa/journal.jsonl` | every event, including each task's final report | you |
| `kalfa.plan.json` | the plan | the run |

So each task prompt hands over what the session cannot: which tasks already
landed, an instruction to read `DECISIONS.md` first, and a pointer to
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
kalfa plan "add rate limiting to the webhook dispatcher"
kalfa validate                          # checks config + plan, execution order
kalfa run                               # go to bed
```

In the morning:

```bash
cat DECISIONS.md           # every question it did not wake you up for
cat BLOCKED.md             # what it refused to do, and why
git log --oneline          # one commit per task
kalfa run --run-id <id>    # resume: finished tasks are skipped
```

| Command | What it does |
|---|---|
| `kalfa init [--force]` | Write starter `kalfa.yaml` and `kalfa.plan.json` |
| `kalfa plan "<goal>"` | Inspect the repo, ask its questions once, write a validated plan |
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

**Vagueness here becomes an assumption in `DECISIONS.md`.** That is the deal —
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
> surrounding codebase, then append to `DECISIONS.md` what you assumed, why,
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

- **Codex cost is reported as $0.** The `codex exec` CLI does not print
  per-run cost, and Kalfa will not invent a number from a local price table.
  Reported run cost is the builder's cost only, and is therefore a floor.
- **Tasks run one at a time.** Independent tasks could run in parallel; they
  don't yet. Wall-clock is the sum of the plan.
- **No quality measurement.** The gates prove the code compiles, passes tests
  and survives review. Nothing measures whether the result is *good*. That
  judgement is still yours — which is what the morning diff is for.
- **Retry feedback is per-attempt, not cumulative.** Attempt 3 is told about
  attempt 2's failure, not attempt 1's. It can read the working tree to see
  what was tried, but nothing stops it oscillating between two wrong fixes.
- **`DECISIONS.md` grows without bound, and every task is told to read it.** On
  a long plan that is a real and rising context cost per task, and eventually
  a task will read it partially or not at all. Split long runs.
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
npm test         # 85 tests, no API calls
npm run typecheck
npm run build
```

The runner tests drive a real git repository in a temp directory with the
agents stubbed. Git behaviour — commit per task, stash on failure, a clean tree
between tasks — is the part most worth testing, and mocking it would test
nothing.

## License

MIT
