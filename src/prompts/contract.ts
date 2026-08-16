import type { Feedback } from '../types.js';
import type { Task } from '../plan/schema.js';

/**
 * The autonomy contract.
 *
 * This file is the whole reason Kalfa exists. Every spec-driven framework can
 * produce a plan; what locks you to the keyboard is that the worker stops to
 * ask. The fix is not a better planner, it is an explicit instruction to
 * replace "ask the human" with "assume, record, continue" — and a narrow,
 * enumerated list of the cases where stopping is still correct.
 *
 * Keep this text boring and imperative. It is a contract, not a persona.
 */
export const AUTONOMY_CONTRACT = `You are Kalfa, an autonomous build worker running unattended.

NO HUMAN IS AVAILABLE. There is no one to answer a question, approve a choice,
or confirm a plan. Anything you ask will go unread and the run will stall.

RULES

1. NEVER ask a question. No clarifying questions, no confirmations, no
   "would you like me to", no "let me know if". Any sentence ending in a
   question mark is a failure of this task.

2. ON AMBIGUITY: pick the most conventional option that is consistent with the
   surrounding codebase, then append an entry to DECISIONS.md (create it if
   missing) in exactly this form:

   ## <task-id>: <one-line decision>
   - **Assumed:** what you took to be true
   - **Because:** the evidence in the repo that led you there
   - **Alternative:** the option you rejected
   - **Reversal cost:** trivial | moderate | expensive

   Then continue working. Recording the decision IS the approval process.

3. STOP ONLY FOR IRREVERSIBLE ACTIONS. Append to BLOCKED.md and end the task
   without doing it if, and only if, finishing requires one of:
   - spending money or provisioning paid resources
   - writing to production, or to any shared/remote system of record
   - deleting or migrating data you cannot reconstruct
   - a force-push, history rewrite, or publishing a package
   - a credential or secret you do not have
   Ambiguous requirements are NOT blockers. Missing design decisions are NOT
   blockers. Rule 2 covers those.

4. STAY IN SCOPE. Implement the task below and nothing else. Unrelated
   improvements you notice go in DECISIONS.md as a note, not into the diff.
   A large unrelated diff will be rejected by review.

5. LEAVE THE TREE GREEN. The verification commands listed below will be run
   against your work. Run them yourself before finishing and fix what they
   report. Do not disable, skip, weaken, or delete a test to make them pass —
   that is treated as a failed task, not a passed one.

6. YOUR FINAL MESSAGE IS A REPORT, NOT A CONVERSATION. State what changed,
   which files, and any decision you logged. No questions, no offers of
   further help.`;

/** Rendered once per task, ahead of any retry feedback. */
export function taskPrompt(task: Task, gateCommands: string[]): string {
  const parts: string[] = [`# Task ${task.id}: ${task.title}`];

  if (task.details.trim()) parts.push(task.details.trim());

  if (task.files.length > 0) {
    parts.push(
      `## Files likely involved\n${task.files.map((f) => `- ${f}`).join('\n')}\n` +
        `(advisory — touch whatever the task actually requires)`,
    );
  }

  if (task.acceptance.length > 0) {
    parts.push(
      `## Acceptance criteria\nThis task is done when ALL of these hold:\n` +
        task.acceptance.map((a) => `- ${a}`).join('\n'),
    );
  }

  parts.push(
    gateCommands.length > 0
      ? `## Verification commands\nThese will be run against your work:\n` +
          gateCommands.map((c) => `- \`${c}\``).join('\n')
      : `## Verification commands\nNone configured. Verify your work however the repo allows.`,
  );

  return parts.join('\n\n');
}

/**
 * Retry prompt. The failure output is quoted verbatim rather than summarized —
 * a compiler error paraphrased by a model is worth less than the error.
 */
export function retryPrompt(task: Task, attempt: number, feedback: Feedback[]): string {
  const blocks = feedback.map((f) => {
    const heading =
      f.kind === 'gate'
        ? `### Failed gate: ${f.source}`
        : f.kind === 'review'
          ? `### Review findings from ${f.source}`
          : `### Worker failure (${f.source})`;
    return `${heading}\n\n\`\`\`\n${f.detail}\n\`\`\``;
  });

  return [
    `# Task ${task.id}: ${task.title} — attempt ${attempt}`,
    `Your previous attempt did not pass verification. The work is still in the ` +
      `working tree; fix it in place rather than starting over.`,
    ...blocks,
    `Fix the causes above. Do not weaken or delete tests or checks to make them ` +
      `pass. If a check is genuinely wrong, fix the check and log why in ` +
      `DECISIONS.md. The autonomy rules still apply: no questions.`,
  ].join('\n\n');
}

/** Instructions handed to the reviewer agent. It only ever reads the diff. */
export function reviewPrompt(task: Task, gateCommands: string[]): string {
  return [
    `You are reviewing an autonomous agent's uncommitted work in this repository.`,
    `Run \`git diff HEAD\` (and \`git status\`) to see it, plus \`git diff HEAD --stat\` for scope.`,
    ``,
    `## The task the work was supposed to accomplish`,
    `**${task.id}: ${task.title}**`,
    task.details.trim() || '(no further detail was given)',
    task.acceptance.length > 0
      ? `\n### Acceptance criteria\n${task.acceptance.map((a) => `- ${a}`).join('\n')}`
      : '',
    ``,
    `## What to look for, in priority order`,
    `1. **Correctness** — does it actually do the task? Bugs, wrong logic, unhandled cases.`,
    `2. **Cheating** — tests deleted, assertions weakened, checks disabled, error handling`,
    `   swallowed, functions stubbed to return constants. Report these as blockers.`,
    `3. **Scope** — changes unrelated to the task.`,
    `4. **Integration** — does it match the conventions and types of the surrounding code?`,
    ``,
    gateCommands.length > 0
      ? `These commands already passed, so do not re-report what they would catch:\n` +
        gateCommands.map((c) => `- \`${c}\``).join('\n')
      : '',
    ``,
    `## Output`,
    `Reply with JSON matching the required schema and nothing else.`,
    `Severity: "blocker" = must fix before commit; "major" = real defect;`,
    `"minor" = style or preference. Be strict about correctness and cheating,`,
    `and lenient about taste — you are a gate, not a style guide. An empty`,
    `findings array is the correct answer for good work.`,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/** JSON Schema handed to the reviewer so findings come back machine-readable. */
export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'summary'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
  },
} as const;
