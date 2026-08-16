import { z } from 'zod';

/**
 * The plan is the contract between the one interactive session you sit
 * through and every unattended run that follows. It is deliberately dumb:
 * an ordered list of tasks with dependencies and machine-checkable
 * acceptance criteria. No prose, no phases, no approval gates.
 */

export const TaskSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/, 'task id must be filename-safe (A-Z a-z 0-9 . _ -)'),
    title: z.string().min(1),
    /** Everything the worker needs. Assume it has never seen the plan. */
    details: z.string().default(''),
    /** Task ids that must be `done` before this one starts. */
    deps: z.array(z.string()).default([]),
    /** Advisory: files the task is expected to touch. Not enforced. */
    files: z.array(z.string()).default([]),
    /**
     * What "finished" means, in checkable terms. These go into the prompt
     * verbatim and into the reviewer's instructions.
     */
    acceptance: z.array(z.string()).default([]),
    /** Gate names to run for this task. Omitted means "all configured gates". */
    gates: z.array(z.string()).optional(),
    /** Skip the reviewer for this task (e.g. pure config churn). */
    review: z.boolean().optional(),
  })
  .strict();

export const PlanSchema = z
  .object({
    version: z.literal(1),
    goal: z.string().min(1),
    tasks: z.array(TaskSchema).min(1),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const task of plan.tasks) {
      if (ids.has(task.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate task id "${task.id}"` });
      }
      ids.add(task.id);
    }
    for (const task of plan.tasks) {
      for (const dep of task.deps) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `task "${task.id}" depends on unknown task "${dep}"`,
          });
        }
        if (dep === task.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `task "${task.id}" depends on itself`,
          });
        }
      }
    }
    const cycle = findCycle(plan.tasks);
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `dependency cycle: ${cycle.join(' -> ')}`,
      });
    }
  });

export type Task = z.infer<typeof TaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/** Depth-first cycle detection; returns the offending path for the error. */
function findCycle(tasks: { id: string; deps: string[] }[]): string[] | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const mark = state.get(id);
    if (mark === 'done') return undefined;
    if (mark === 'visiting') return [...path.slice(path.indexOf(id)), id];

    state.set(id, 'visiting');
    path.push(id);
    for (const dep of byId.get(id)?.deps ?? []) {
      if (!byId.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    path.pop();
    state.set(id, 'done');
    return undefined;
  };

  for (const task of tasks) {
    const found = visit(task.id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Topological order, ties broken by the order the author wrote them.
 * Runs are sequential by design: task N+1 usually reads the code task N wrote.
 */
export function topoOrder(plan: Plan): Task[] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  // Mark on entry, push on exit, so a task never precedes its dependency.
  const ordered: Task[] = [];
  const seen = new Set<string>();
  const visit = (task: Task): void => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    for (const dep of task.deps) {
      const depTask = byId.get(dep);
      if (depTask) visit(depTask);
    }
    ordered.push(task);
  };
  for (const task of plan.tasks) visit(task);
  return ordered;
}
