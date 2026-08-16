import { z } from 'zod';
import { DEFAULT_PROTECTED_PATHS } from '../gates/protected.js';

/**
 * `kalfa.yaml` — the operating envelope for an unattended run.
 *
 * Every field here exists to answer one question: what is Kalfa allowed to do
 * while nobody is watching, and what must be true before it commits?
 */

export const ProviderSchema = z.enum(['claude', 'codex']);
export type Provider = z.infer<typeof ProviderSchema>;

export const AgentSchema = z
  .object({
    provider: ProviderSchema,
    /** Provider-native model id or alias. Omitted uses the CLI's default. */
    model: z.string().optional(),
    /**
     * claude permission mode.
     *
     * `acceptEdits` is NOT enough for a builder. It auto-approves file edits
     * but not Bash, so an unattended worker that needs to run the test suite
     * stops and reports "I need your approval to run ...". It looks like a
     * successful run — the CLI exits zero and the summary reads like a
     * report — while the work is actually unverified.
     *
     * A builder therefore wants `bypassPermissions`. That is a real grant of
     * power, and the reason it is acceptable here is the surrounding
     * machinery: preflight refuses a dirty tree, work happens on a branch
     * Kalfa cut, every task is its own commit, and nothing ever pushes. Git
     * is the undo button.
     */
    permission_mode: z
      .enum(['acceptEdits', 'bypassPermissions', 'dontAsk', 'auto'])
      .default('bypassPermissions'),
    /** codex sandbox policy. Ignored for the claude provider. */
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
    max_turns: z.number().int().positive().optional(),
    /**
     * Tool restrictions, claude provider only. The reviewer should be denied
     * write tools: a reviewer that can edit is a second builder, and it will
     * "fix" what it finds instead of reporting it.
     */
    allowed_tools: z.array(z.string()).optional(),
    disallowed_tools: z.array(z.string()).optional(),
    /** Extra directories the agent may write to, beyond the repo root. */
    add_dirs: z.array(z.string()).default([]),
    /** Appended to the provider's system prompt, after Kalfa's own contract. */
    system_prompt_append: z.string().optional(),
    /** Hard wall-clock ceiling for a single invocation. */
    timeout_ms: z.number().int().positive().default(30 * 60 * 1000),
  })
  .strict();

export const GateSchema = z
  .object({
    name: z.string().min(1),
    run: z.string().min(1),
    /**
     * A failing non-required gate is reported and fed back, but does not by
     * itself force a retry. Use for slow or flaky checks.
     */
    required: z.boolean().default(true),
    timeout_ms: z.number().int().positive().default(10 * 60 * 1000),
    /** How much tail output to hand back to the agent on failure. */
    max_output_chars: z.number().int().positive().default(6000),
  })
  .strict();

export const PolicySchema = z
  .object({
    /** Attempts per task, including the first. */
    max_attempts: z.number().int().min(1).default(3),
    /** Run the reviewer agent after gates pass. */
    review: z.boolean().default(true),
    /** Findings at or above this severity force another attempt. */
    blocking_severity: z.enum(['blocker', 'major', 'minor']).default('major'),
    /**
     * Re-ask the reviewer once before a blocking finding costs the work.
     *
     * On the final attempt a block is not a retry, it is a stash: the work is
     * thrown away. Reviewers are not oracles — one was observed inventing a
     * blocker and withdrawing it when asked again with nothing changed — so a
     * confirming read is cheap insurance at exactly the moment it matters.
     * Only a clean second read overturns the block.
     */
    review_second_opinion: z.boolean().default(true),
    /**
     * Check a finding's claim against the diff before it may block a task.
     *
     * A finding the reviewer labels `file_changed` names a file it says this
     * diff touched. That is looked up in the pending change list, and a finding
     * naming a file git shows untouched is reported and then discarded — it was
     * refuted by the only authority in the room that cannot be talked round.
     * Findings about anything else are untouched by this.
     *
     * Costs nothing and calls no one. Turn it off only if you would rather
     * adjudicate a fabricated blocker yourself in the morning.
     */
    verify_review_claims: z.boolean().default(true),
    /** Commit after each task passes, so a failure never loses earlier work. */
    commit_per_task: z.boolean().default(true),
    /** Branch to create for the run. `{run_id}` is substituted. */
    branch: z.string().default('kalfa/{run_id}'),
    /** Work on the current branch instead of cutting a new one. */
    use_current_branch: z.boolean().default(false),
    /**
     * A task that exhausts its attempts leaves a dirty tree. Stashing keeps
     * the next task honest while preserving the work for you to inspect.
     */
    stash_failed_work: z.boolean().default(true),
    /** Stop the whole run after this many consecutive blocked tasks. */
    abort_after_consecutive_blocks: z.number().int().min(1).default(3),
    /** Ceiling for the entire run. Exceeding it stops before the next task. */
    max_run_cost_usd: z.number().positive().optional(),
    /**
     * Globs for files a task should not normally be rewriting — tests and
     * checks. Touching one is not forbidden, it is *reported*: the reviewer is
     * told to verify rather than accept the justification, and the change is
     * surfaced on the board so you see it in the morning.
     *
     * Set to [] to disable. See src/gates/protected.ts for why this is a
     * mechanical check rather than a judgement left to the reviewer.
     */
    protected_paths: z.array(z.string()).default(DEFAULT_PROTECTED_PATHS),
  })
  .strict();

/**
 * What a run writes down about itself.
 *
 * Kalfa's bargain is asynchronous review, and that only holds if a finished
 * run — or a live one — can be interrogated. The defaults keep every piece of
 * evidence a failure needs, and stop short of the one thing that is genuinely
 * sensitive: the prompts, which embed task details and repository content.
 */
export const ObservabilitySchema = z
  .object({
    /** Persist per-attempt stdout/stderr, gate output and reviewer payloads. */
    artifacts: z.boolean().default(true),
    /**
     * Also write each attempt's prompt to its artifact directory.
     *
     * Off by default. A prompt carries the task's details and whatever the
     * planner learned about the repository, and artifacts are made to be
     * pasted into issues.
     */
    capture_prompts: z.boolean().default(false),
    /** Extra regular expressions masked out of everything Kalfa writes. */
    redact_patterns: z.array(z.string()).default([]),
  })
  .strict();

/**
 * How the operator finds out the run needs them.
 *
 * Kalfa owns no integrations — no Slack, no email, no desktop toast. It runs
 * one command and hands it a JSON payload on stdin, which is enough to build
 * any of those in three lines and commits Kalfa to maintaining none of them.
 */
export const NotifySchema = z
  .object({
    /** Shell command receiving the payload on stdin. Nothing fires without it. */
    command: z.string().min(1).optional(),
    /** Which terminal states are worth a notification. */
    on: z
      .array(z.enum(['completed', 'blocked', 'failed']))
      .default(['completed', 'blocked', 'failed']),
    /** A hook that hangs must not hold the run open. */
    timeout_ms: z.number().int().positive().default(30 * 1000),
  })
  .strict();

export const ConfigSchema = z
  .object({
    agents: z
      .object({
        /** Writes the code. */
        builder: AgentSchema,
        /** Reviews the diff. Should be a different provider than builder. */
        reviewer: AgentSchema.optional(),
      })
      .strict(),
    gates: z.array(GateSchema).default([]),
    policy: PolicySchema.default({}),
    observability: ObservabilitySchema.default({}),
    notify: NotifySchema.default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const names = new Set<string>();
    for (const gate of config.gates) {
      if (names.has(gate.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate gate name "${gate.name}"` });
      }
      names.add(gate.name);
    }
    if (config.policy.review && !config.agents.reviewer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'policy.review is true but agents.reviewer is not configured',
      });
    }
    // A redaction pattern that does not compile silently protects nothing, and
    // the artifacts it was meant to scrub are written to disk anyway. Caught
    // here, where a config mistake is free to fix.
    for (const source of config.observability.redact_patterns) {
      try {
        new RegExp(source, 'g');
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `observability.redact_patterns: "${source}" is not a valid regular expression (${(err as Error).message})`,
        });
      }
    }
  });

export type AgentConfig = z.infer<typeof AgentSchema>;
export type GateConfig = z.infer<typeof GateSchema>;
export type PolicyConfig = z.infer<typeof PolicySchema>;
export type ObservabilityConfig = z.infer<typeof ObservabilitySchema>;
export type NotifyConfig = z.infer<typeof NotifySchema>;
export type KalfaConfig = z.infer<typeof ConfigSchema>;

export const SEVERITY_RANK: Record<'minor' | 'major' | 'blocker', number> = {
  minor: 1,
  major: 2,
  blocker: 3,
};
