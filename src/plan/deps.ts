import type { Plan, Task } from './schema.js';

/**
 * What a plan's dependency graph costs if it is wrong.
 *
 * `PlanSchema` already checks that a graph is *coherent*: ids resolve, nothing
 * depends on itself, there are no cycles. None of that says the edges are
 * real, and an invented edge is not free. On a live six-task run the planner
 * produced a strictly linear chain — every task depending on exactly its
 * predecessor, including a documentation task that depended on the CLI task
 * before it. The prompt tells it not to do this. It did it anyway, and when
 * task 4 failed, tasks 5 and 6 were skipped for a dependency neither of them
 * needed. One failure cost three tasks.
 *
 * Nothing here can tell a real edge from an invented one — that needs to know
 * what the code does. What it can do is refuse to let the question go unasked,
 * by putting the two mechanical facts in front of the reader before the run:
 * the shape of the graph, and what each task's failure would take down with
 * it. Reading a generated plan takes five minutes; a bad plan costs a night.
 *
 * Everything here is advisory. Nothing fails a plan.
 */

/** A dependency between two tasks that declare files, sharing none of them. */
export interface UnsharedDep {
  taskId: string;
  dep: string;
  /** The declared files on each side, for the reader to judge. */
  files: string[];
  depFiles: string[];
}

export interface DepAnalysis {
  /**
   * True when the plan is a strict linear chain: every task depends on exactly
   * its predecessor and nothing else.
   *
   * This is the planner's default failure, not a legitimate shape that happens
   * to look suspicious. A real plan almost always has at least one task that
   * could start early, and a chain converts any single failure into the loss
   * of everything after it.
   */
  isChain: boolean;
  /** Per task id: how many other tasks would be skipped if it blocked. */
  cascade: Map<string, number>;
  /** The single task whose failure would cost the most, when any would. */
  worst?: { taskId: string; count: number };
  /**
   * Dependencies where both tasks name files and the sets do not intersect.
   *
   * Weak evidence on its own — T6 may legitimately import what T5 wrote
   * without touching its files — but it is where an invented edge shows up,
   * and it is a short list to read.
   */
  unshared: UnsharedDep[];
}

function normalizeFile(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/** Task ids that would never run if `id` blocked — its transitive dependents. */
function dependentsOf(id: string, dependents: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  const queue = [...(dependents.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (out.has(next)) continue;
    out.add(next);
    queue.push(...(dependents.get(next) ?? []));
  }
  return out;
}

export function analyseDeps(plan: Plan): DepAnalysis {
  const tasks: Task[] = plan.tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.deps) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
    }
  }

  const cascade = new Map<string, number>();
  for (const task of tasks) cascade.set(task.id, dependentsOf(task.id, dependents).size);

  let worst: DepAnalysis['worst'];
  for (const [taskId, count] of cascade) {
    if (count > 0 && (!worst || count > worst.count)) worst = { taskId, count };
  }

  // Three is the shortest plan where a chain is a claim rather than a
  // coincidence: with two tasks, "the second needs the first" is ordinary.
  const isChain =
    tasks.length >= 3 &&
    tasks[0]!.deps.length === 0 &&
    tasks.slice(1).every((task, i) => task.deps.length === 1 && task.deps[0] === tasks[i]!.id);

  const unshared: UnsharedDep[] = [];
  for (const task of tasks) {
    for (const dep of task.deps) {
      const depTask = byId.get(dep);
      if (!depTask) continue;
      // No declared files on either side is no evidence, not evidence of
      // absence. `files` is advisory and plenty of good plans leave it empty.
      if (task.files.length === 0 || depTask.files.length === 0) continue;
      const theirs = new Set(depTask.files.map(normalizeFile));
      if (task.files.map(normalizeFile).some((f) => theirs.has(f))) continue;
      unshared.push({ taskId: task.id, dep, files: task.files, depFiles: depTask.files });
    }
  }

  return { isChain, cascade, ...(worst ? { worst } : {}), unshared };
}

/**
 * The advisory lines, or none when the graph has nothing to answer for.
 *
 * Written as warnings in the same shape `validate` already uses for the config:
 * a claim, then what it costs, then what to do about it.
 */
export function formatDepWarnings(plan: Plan, indent = '  '): string[] {
  const analysis = analyseDeps(plan);
  const lines: string[] = [];
  const pad = `${indent}          `;

  if (analysis.isChain) {
    lines.push(
      `${indent}warning:  this plan is a strict linear chain — every task depends on exactly`,
      `${pad}the one before it. Planners produce that shape by default and it is`,
      `${pad}rarely the real graph. It also has no slack: the first task to block`,
      `${pad}takes every task after it down with it, needed or not.`,
      `${pad}Read each \`deps\` and delete the ones that are not real.`,
    );
  }

  if (analysis.worst && analysis.worst.count > 1 && !analysis.isChain) {
    lines.push(
      `${indent}note:     ${analysis.worst.taskId} carries the most — ${analysis.worst.count} tasks would be skipped`,
      `${pad}if it blocked. Worth being sure they all really need it.`,
    );
  }

  // Suppressed under a chain warning, which has already told the reader to
  // check every dependency in the plan. Listing them again as suspects is the
  // same advice at twice the length, and a warning nobody finishes reading is
  // a warning that does not work.
  if (analysis.unshared.length > 0 && !analysis.isChain) {
    lines.push(
      `${indent}note:     ${analysis.unshared.length} dependenc${
        analysis.unshared.length === 1 ? 'y connects tasks' : 'ies connect tasks'
      } that share no declared files:`,
    );
    // Bounded, and says so. A list long enough to scroll past is not read.
    const shown = analysis.unshared.slice(0, 5);
    for (const dep of shown) {
      lines.push(`${pad}  ${dep.taskId} <- ${dep.dep}   (${dep.files.join(', ')} vs ${dep.depFiles.join(', ')})`);
    }
    if (analysis.unshared.length > shown.length) {
      lines.push(`${pad}  ... and ${analysis.unshared.length - shown.length} more`);
    }
    lines.push(
      `${pad}That can be legitimate — a task may import what an earlier one`,
      `${pad}wrote without touching its files — but it is where an invented`,
      `${pad}dependency shows up.`,
    );
  }

  return lines;
}
