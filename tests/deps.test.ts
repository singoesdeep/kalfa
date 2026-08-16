import { describe, expect, it } from 'vitest';
import { analyseDeps, formatDepWarnings } from '../src/plan/deps.js';
import { PlanSchema, type Plan } from '../src/plan/schema.js';

/** A plan built from the parts that matter here, validated like a real one. */
function plan(tasks: Array<{ id: string; deps?: string[]; files?: string[] }>): Plan {
  return PlanSchema.parse({
    version: 1,
    goal: 'test',
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.id,
      deps: t.deps ?? [],
      files: t.files ?? [],
    })),
  });
}

describe('analyseDeps: what a failure would cost', () => {
  it('counts the tasks a block would take down, transitively', () => {
    const { cascade } = analyseDeps(
      plan([{ id: 'T1' }, { id: 'T2', deps: ['T1'] }, { id: 'T3', deps: ['T2'] }]),
    );
    expect(cascade.get('T1')).toBe(2);
    expect(cascade.get('T2')).toBe(1);
    expect(cascade.get('T3')).toBe(0);
  });

  it('counts a task reachable by two paths once', () => {
    const { cascade } = analyseDeps(
      plan([
        { id: 'T1' },
        { id: 'T2', deps: ['T1'] },
        { id: 'T3', deps: ['T1'] },
        { id: 'T4', deps: ['T2', 'T3'] },
      ]),
    );
    expect(cascade.get('T1')).toBe(3);
  });

  it('names the task carrying the most, so the reader knows where to look', () => {
    const { worst } = analyseDeps(
      plan([{ id: 'T1' }, { id: 'T2', deps: ['T1'] }, { id: 'T3', deps: ['T1'] }]),
    );
    expect(worst).toEqual({ taskId: 'T1', count: 2 });
  });

  it('has no worst case when nothing depends on anything', () => {
    expect(analyseDeps(plan([{ id: 'T1' }, { id: 'T2' }])).worst).toBeUndefined();
  });
});

describe('analyseDeps: the chain the planner produces by default', () => {
  // The observed failure: six tasks, each depending on exactly its
  // predecessor, including a documentation task that depended on a CLI task.
  // Task 4 failed and tasks 5 and 6 were skipped for a dependency neither had.
  it('recognises a strict linear chain', () => {
    const chained = plan([
      { id: 'T1' },
      { id: 'T2', deps: ['T1'] },
      { id: 'T3', deps: ['T2'] },
      { id: 'T4', deps: ['T3'] },
    ]);
    expect(analyseDeps(chained).isChain).toBe(true);
    expect(formatDepWarnings(chained).join('\n')).toContain('strict linear chain');
  });

  it('does not call a graph with any slack a chain', () => {
    const forked = plan([{ id: 'T1' }, { id: 'T2', deps: ['T1'] }, { id: 'T3', deps: ['T1'] }]);
    expect(analyseDeps(forked).isChain).toBe(false);
  });

  // With two tasks "the second needs the first" is ordinary, not a shape worth
  // reporting. Warning about it would train the reader to skip the warnings.
  it('says nothing about a two-task plan', () => {
    expect(analyseDeps(plan([{ id: 'T1' }, { id: 'T2', deps: ['T1'] }])).isChain).toBe(false);
  });

  it('does not call a plan of independent tasks a chain', () => {
    expect(analyseDeps(plan([{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }])).isChain).toBe(false);
  });
});

describe('analyseDeps: dependencies with nothing in common', () => {
  it('reports a dependency between tasks that share no declared file', () => {
    const { unshared } = analyseDeps(
      plan([
        { id: 'T1', files: ['src/cli.ts'] },
        { id: 'T2', deps: ['T1'], files: ['docs/README.md'] },
      ]),
    );
    expect(unshared).toHaveLength(1);
    expect(unshared[0]).toMatchObject({ taskId: 'T2', dep: 'T1' });
  });

  it('says nothing when the files overlap', () => {
    const { unshared } = analyseDeps(
      plan([
        { id: 'T1', files: ['src/cli.ts'] },
        { id: 'T2', deps: ['T1'], files: ['./SRC/cli.ts', 'src/x.ts'] },
      ]),
    );
    expect(unshared).toHaveLength(0);
  });

  // `files` is advisory and plenty of good plans leave it empty. An absent
  // declaration is no evidence, not evidence of absence.
  it('says nothing when either side declared no files', () => {
    const { unshared } = analyseDeps(
      plan([{ id: 'T1', files: ['src/cli.ts'] }, { id: 'T2', deps: ['T1'] }]),
    );
    expect(unshared).toHaveLength(0);
  });
});

describe('formatDepWarnings', () => {
  it('is silent about a graph with nothing to answer for', () => {
    expect(formatDepWarnings(plan([{ id: 'T1' }, { id: 'T2' }]))).toEqual([]);
  });

  it('shows both sides of an unshared dependency, so it can be judged', () => {
    const text = formatDepWarnings(
      plan([
        { id: 'T1', files: ['src/cli.ts'] },
        { id: 'T2', deps: ['T1'], files: ['docs/README.md'] },
      ]),
    ).join('\n');
    expect(text).toContain('T2 <- T1');
    expect(text).toContain('docs/README.md');
    expect(text).toContain('src/cli.ts');
  });

  // A chain already says "every task depends on its predecessor". Adding
  // "T1 carries the most" underneath it is the same fact twice.
  it('does not repeat the chain warning as a blast-radius note', () => {
    const text = formatDepWarnings(
      plan([{ id: 'T1' }, { id: 'T2', deps: ['T1'] }, { id: 'T3', deps: ['T2'] }]),
    ).join('\n');
    expect(text).toContain('strict linear chain');
    expect(text).not.toContain('carries the most');
  });

  // Same reason: under a chain warning every dependency is already a suspect,
  // so listing each one is advice at twice the length.
  it('does not list unshared dependencies under a chain warning', () => {
    const chained = plan([
      { id: 'T1', files: ['src/a.ts'] },
      { id: 'T2', deps: ['T1'], files: ['src/b.ts'] },
      { id: 'T3', deps: ['T2'], files: ['docs/x.md'] },
    ]);
    expect(analyseDeps(chained).unshared).toHaveLength(2);
    expect(formatDepWarnings(chained).join('\n')).not.toContain('share no declared files');
  });

  it('bounds the unshared list rather than printing a page of it', () => {
    const wide = plan([
      { id: 'H', files: ['src/hub.ts'] },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `T${i}`,
        deps: ['H'],
        files: [`src/leaf${i}.ts`],
      })),
    ]);
    const text = formatDepWarnings(wide).join('\n');
    expect(text).toContain('8 dependencies');
    expect(text).toContain('... and 3 more');
  });
});
