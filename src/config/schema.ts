import { z } from 'zod';

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
  });

export type AgentConfig = z.infer<typeof AgentSchema>;
export type GateConfig = z.infer<typeof GateSchema>;
export type PolicyConfig = z.infer<typeof PolicySchema>;
export type KalfaConfig = z.infer<typeof ConfigSchema>;

export const SEVERITY_RANK: Record<'minor' | 'major' | 'blocker', number> = {
  minor: 1,
  major: 2,
  blocker: 3,
};
