import { describe, expect, it } from 'vitest';
import { PlanSchema, topoOrder } from '../src/plan/schema.js';

const base = { version: 1 as const, goal: 'g' };

describe('plan schema', () => {
  it('accepts a minimal plan', () => {
    const parsed = PlanSchema.safeParse({ ...base, tasks: [{ id: 'T1', title: 'x' }] });
    expect(parsed.success).toBe(true);
  });

  it('rejects duplicate ids', () => {
    const parsed = PlanSchema.safeParse({
      ...base,
      tasks: [
        { id: 'T1', title: 'a' },
        { id: 'T1', title: 'b' },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain('duplicate task id');
  });

  it('rejects a dependency on an unknown task', () => {
    const parsed = PlanSchema.safeParse({
      ...base,
      tasks: [{ id: 'T1', title: 'a', deps: ['T9'] }],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain('unknown task');
  });

  it('rejects a dependency cycle', () => {
    const parsed = PlanSchema.safeParse({
      ...base,
      tasks: [
        { id: 'A', title: 'a', deps: ['B'] },
        { id: 'B', title: 'b', deps: ['A'] },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain('cycle');
  });

  it('rejects unknown fields rather than silently ignoring them', () => {
    const parsed = PlanSchema.safeParse({
      ...base,
      tasks: [{ id: 'T1', title: 'a', dependsOn: ['T0'] }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('topoOrder', () => {
  it('places every dependency before its dependent', () => {
    const plan = PlanSchema.parse({
      ...base,
      tasks: [
        { id: 'C', title: 'c', deps: ['B'] },
        { id: 'A', title: 'a' },
        { id: 'B', title: 'b', deps: ['A'] },
      ],
    });
    const order = topoOrder(plan).map((t) => t.id);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('C'));
  });

  it('preserves author order among independent tasks', () => {
    const plan = PlanSchema.parse({
      ...base,
      tasks: [
        { id: 'X', title: 'x' },
        { id: 'Y', title: 'y' },
        { id: 'Z', title: 'z' },
      ],
    });
    expect(topoOrder(plan).map((t) => t.id)).toEqual(['X', 'Y', 'Z']);
  });

  it('emits each task exactly once when it is a shared dependency', () => {
    const plan = PlanSchema.parse({
      ...base,
      tasks: [
        { id: 'A', title: 'a' },
        { id: 'B', title: 'b', deps: ['A'] },
        { id: 'C', title: 'c', deps: ['A'] },
      ],
    });
    expect(topoOrder(plan).map((t) => t.id)).toEqual(['A', 'B', 'C']);
  });
});
