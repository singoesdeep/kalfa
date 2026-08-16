import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigSchema, type KalfaConfig } from './schema.js';
import { PlanSchema, type Plan } from '../plan/schema.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_CONFIG_NAMES = ['kalfa.yaml', 'kalfa.yml'];

export function findConfigPath(cwd: string, explicit?: string): string {
  if (explicit) return resolve(cwd, explicit);
  for (const name of DEFAULT_CONFIG_NAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return resolve(cwd, DEFAULT_CONFIG_NAMES[0]!);
}

/** Turn a zod error into something readable without a stack trace. */
function formatIssues(error: z.ZodError, path: string): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  ${where}: ${issue.message}`;
  });
  return `${path} is not valid:\n${lines.join('\n')}`;
}

export function loadConfig(cwd: string, explicit?: string): { config: KalfaConfig; path: string } {
  const path = findConfigPath(cwd, explicit);
  if (!existsSync(path)) {
    throw new ConfigError(`no config at ${path} — run \`kalfa init\` to write a starter one`, path);
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${path} is not valid YAML: ${(err as Error).message}`, path);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error, path), path);
  return { config: parsed.data, path };
}

export function loadPlan(cwd: string, planPath: string): { plan: Plan; path: string } {
  const path = resolve(cwd, planPath);
  if (!existsSync(path)) throw new ConfigError(`no plan at ${path}`, path);

  let raw: unknown;
  try {
    const text = readFileSync(path, 'utf8');
    raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${path} could not be parsed: ${(err as Error).message}`, path);
  }

  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error, path), path);
  return { plan: parsed.data, path };
}
