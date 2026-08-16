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
   surrounding codebase, record it as an Architecture Decision Record (the
   format is given below), and continue working.

   Writing the record IS the approval process. It is not paperwork about the
   work; for an ambiguous choice, it is part of the work.

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
   improvements you notice go in the task report as a note, not into the diff.
   A large unrelated diff will be rejected by review.

5. LEAVE THE TREE GREEN. The verification commands listed below will be run
   against your work. Run them yourself before finishing and fix what they
   report. Do not disable, skip, weaken, or delete a test to make them pass —
   that is treated as a failed task, not a passed one.

6. YOUR FINAL MESSAGE IS A REPORT, NOT A CONVERSATION. State what changed,
   which files, and any decision you logged. No questions, no offers of
   further help.`;

/**
 * What earlier tasks in this run already did.
 *
 * Every task runs in a FRESH session — nothing carries over in conversation.
 * That is deliberate: context never accumulates, so it never fills, and task
 * 12 is as sharp as task 1. The cost is that a task knows nothing about its
 * predecessors unless told, so the durable artifacts have to stand in for
 * memory. This block is that hand-off.
 */
export function continuitySection(completed: Array<{ id: string; title: string }>): string {
  const lines = [
    `## What has already happened in this run`,
    completed.length === 0
      ? `Nothing yet — this is the first task.`
      : `These tasks are already committed. Their code is in the repository:\n` +
        completed.map((t) => `- ${t.id}: ${t.title}`).join('\n'),
    ``,
    `You have NO memory of those tasks — each runs in a separate session. If`,
    `this task depends on how one of them was implemented, read the code, or`,
    `\`git log --oneline\` for what landed.`,
    ``,
    `**Read \`docs/adr/README.md\` before you start.** It indexes the decisions`,
    `earlier tasks made instead of asking, one line each. Open the records that`,
    `bear on this task. Contradicting one silently is worse than the original`,
    `ambiguity: follow what is written, or supersede it explicitly with a new`,
    `record that names the one it replaces.`,
  ];
  return lines.join('\n');
}

/** Rendered once per task, ahead of any retry feedback. */
export function taskPrompt(
  task: Task,
  gateCommands: string[],
  completed: Array<{ id: string; title: string }> = [],
  adrInstructions?: string,
): string {
  const parts: string[] = [`# Task ${task.id}: ${task.title}`, continuitySection(completed)];
  if (adrInstructions) parts.push(`## Recording decisions\n\n${adrInstructions}`);

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
    // The retry runs in a fresh session, so the agent genuinely cannot recall
    // what it tried. The working tree is the only record — point at it
    // explicitly rather than letting it re-derive the task from scratch.
    `A previous attempt at this task did not pass verification. You have NO ` +
      `memory of it — it ran in a separate session — but its work is still in ` +
      `the working tree.\n\n` +
      `Run \`git diff HEAD\` and \`git status\` FIRST to see what was already ` +
      `done. It may be complete but wrong, or it may have stopped halfway. ` +
      `Fix it in place; do not start over, and do not redo work that is already ` +
      `correct.`,
    ...blocks,
    `Fix the causes above. Do not weaken or delete tests or checks to make them ` +
      `pass. If a check is genuinely wrong, fix the check and log why in ` +
      `an ADR. The autonomy rules still apply: no questions.`,
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
