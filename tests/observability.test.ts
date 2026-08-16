import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/state/artifacts.js';
import { Redactor, invalidPatterns } from '../src/state/redact.js';
import { parseClaudeStream, toolEventsFromLine } from '../src/agents/provider.js';
import { createRenderer } from '../src/cli/render.js';
import type { RunnerEvent } from '../src/runner/runner.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kalfa-obs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Artifacts exist to be read, attached to issues and pasted into chat. That
 * makes them the worst possible place for a token to end up, which is why
 * nothing reaches disk without passing the redactor.
 */
describe('Redactor', () => {
  it('masks the value of a secret-looking environment variable', () => {
    const redactor = new Redactor([], { GITHUB_TOKEN: 's3cr3t-value-9999', PATH: '/usr/bin' });
    const result = redactor.redact('curl -H "Authorization: s3cr3t-value-9999" https://api');

    expect(result.text).not.toContain('s3cr3t-value-9999');
    expect(result.text).toContain('[redacted:GITHUB_TOKEN]');
    expect(result.redacted).toBe(true);
  });

  it('leaves an env var that is not secret-looking alone', () => {
    const redactor = new Redactor([], { HOME: '/home/someone' });
    expect(redactor.redact('cd /home/someone').text).toBe('cd /home/someone');
  });

  it('ignores a secret too short to distinguish from ordinary text', () => {
    const redactor = new Redactor([], { API_KEY: 'test' });
    expect(redactor.redact('this is a test of the thing').redacted).toBe(false);
  });

  it('catches well-known credential shapes that never touched the environment', () => {
    const redactor = new Redactor([], {});
    for (const secret of ['sk-abcdefghijklmnopqrstuvwx', 'ghp_abcdefghijklmnopqrstuvwxyz', 'AKIAIOSFODNN7EXAMPLE']) {
      const result = redactor.redact(`leaked ${secret} here`);
      expect(result.text, secret).not.toContain(secret);
      expect(result.redacted).toBe(true);
    }
  });

  it('applies user-configured patterns', () => {
    const redactor = new Redactor(['INTERNAL-[0-9]{4}'], {});
    expect(redactor.redact('ticket INTERNAL-4821 filed').text).toBe('ticket [redacted] filed');
  });

  it('survives a pattern that does not compile, and reports it separately', () => {
    expect(() => new Redactor(['([unclosed'], {})).not.toThrow();
    expect(invalidPatterns(['([unclosed', 'fine'])).toEqual(['([unclosed']);
  });

  it('reports nothing redacted when nothing matched', () => {
    expect(new Redactor([], {}).redact('ordinary output').redacted).toBe(false);
  });
});

describe('ArtifactStore', () => {
  it('writes an attempt artifact at a path the run can cite', () => {
    const store = new ArtifactStore(dir, '20260816-155225');
    const ref = store.write('T5', 2, 'decision.json', '{"ok":true}');

    expect(ref.path).toBe('.kalfa/runs/20260816-155225/artifacts/T5/2/decision.json');
    expect(readFileSync(join(dir, ref.path), 'utf8')).toBe('{"ok":true}');
  });

  it('nests gate output under the gate name', () => {
    const store = new ArtifactStore(dir, 'r1');
    const ref = store.write('T1', 1, 'gates/project-check.stdout.log', 'all good\n');

    expect(ref.path).toBe('.kalfa/runs/r1/artifacts/T1/1/gates/project-check.stdout.log');
  });

  it('streams a sink to disk as chunks arrive, so a crash still leaves a transcript', () => {
    const store = new ArtifactStore(dir, 'r1');
    const sink = store.sink('T1', 1, 'builder.stdout.log');
    sink.write('first\n');
    sink.write('second\n');
    const ref = sink.close();

    expect(readFileSync(join(dir, ref.path), 'utf8')).toBe('first\nsecond\n');
  });

  it('redacts on the way to disk and says that it did', () => {
    const store = new ArtifactStore(dir, 'r1', new Redactor([], { NPM_TOKEN: 'abcdefgh12345678' }));
    const ref = store.write('T1', 1, 'builder.stdout.log', 'using abcdefgh12345678 to publish');

    expect(ref.redacted).toBe(true);
    expect(readFileSync(join(dir, ref.path), 'utf8')).not.toContain('abcdefgh12345678');
  });

  it('cannot be walked out of the run directory by a hostile task id', () => {
    const store = new ArtifactStore(dir, 'r1');
    const ref = store.write('../../escape', 1, 'x.txt', 'contained');

    expect(ref.path.startsWith('.kalfa/runs/r1/artifacts/')).toBe(true);
    expect(ref.path).not.toContain('..');
  });
});

/**
 * The builder's tool calls are the difference between "running for nine
 * minutes" and "on its fourth npm test". They arrive only because the run
 * asks claude for `--output-format stream-json`.
 */
describe('claude stream parsing', () => {
  it('pulls tool calls out of an assistant line', () => {
    const events = toolEventsFromLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } },
          ],
        },
      }),
    );

    expect(events.map((e) => `${e.name} ${e.detail ?? ''}`)).toEqual(['Bash npm test', 'Edit src/a.ts']);
  });

  it('reports nothing for lines that are not assistant turns', () => {
    expect(toolEventsFromLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([]);
    expect(toolEventsFromLine('not json at all')).toEqual([]);
  });

  it('takes cost and result from the final result line', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.42 }),
    ].join('\n');

    const parsed = parseClaudeStream(stdout);
    expect(parsed.text).toBe('done');
    expect(parsed.costUsd).toBe(0.42);
    expect(parsed.aborted).toBe(false);
  });

  it('still detects an aborted run in the stream', () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: 'partial' });
    expect(parseClaudeStream(stdout).aborted).toBe(true);
  });

  it('falls back to whole-output parsing when no result line arrived', () => {
    // An older CLI, or a stream cut off mid-flight. Losing the run entirely
    // would be worse than reading what is there.
    expect(parseClaudeStream(JSON.stringify({ result: 'plain json output' })).text).toBe(
      'plain json output',
    );
  });
});

describe('renderer', () => {
  const collect = (events: RunnerEvent[], verbose = false, jsonl = false): string => {
    let out = '';
    const render = createRenderer({ verbose, jsonl, write: (text) => (out += text) });
    for (const event of events) render(event);
    return out;
  };

  it('names the exact gate command before it runs, in every mode', () => {
    const out = collect([
      {
        type: 'command_start',
        taskId: 'T5',
        attempt: 2,
        phase: 'gate',
        name: 'test',
        command: 'godot --headless --run-tests',
      },
    ]);
    expect(out).toContain('godot --headless --run-tests');
  });

  it('reports the active phase, which used to be silence', () => {
    const out = collect([{ type: 'phase', taskId: 'T5', attempt: 1, phase: 'builder', detail: 'claude:sonnet' }]);
    expect(out).toContain('builder running');
    expect(out).toContain('claude:sonnet');
  });

  it('points a failing gate at its untruncated output', () => {
    const out = collect([
      {
        type: 'gates_done',
        taskId: 'T5',
        attempt: 1,
        results: [
          {
            name: 'test',
            ok: false,
            exitCode: 1,
            output: 'boom',
            durationMs: 6668,
            stdoutPath: '.kalfa/runs/r1/artifacts/T5/1/gates/test.stdout.log',
          },
        ],
      },
    ]);
    expect(out).toContain('FAIL');
    expect(out).toContain('.kalfa/runs/r1/artifacts/T5/1/gates/test.stdout.log');
  });

  it('makes a retry cause point at the attempt that caused it', () => {
    const out = collect([
      {
        type: 'retrying',
        taskId: 'T5',
        attempt: 2,
        reason: 'test: 3 failing',
        causedBy: '.kalfa/runs/r1/artifacts/T5/1',
      },
    ]);
    expect(out).toContain('test: 3 failing');
    expect(out).toContain('evidence .kalfa/runs/r1/artifacts/T5/1/');
  });

  it('links a blocking review to its complete findings', () => {
    const out = collect([
      {
        type: 'review_done',
        taskId: 'T5',
        attempt: 3,
        findings: 3,
        blocking: 2,
        findingsPath: '.kalfa/runs/r1/artifacts/T5/3/review.findings.json',
        details: [{ severity: 'blocker', summary: 'the test file was modified', file: 'tests/a.test.ts' }],
      },
    ]);
    expect(out).toContain('2 blocking');
    expect(out).toContain('review.findings.json');
    expect(out).toContain('the test file was modified');
  });

  it('keeps tool calls and raw output for --verbose only', () => {
    const events: RunnerEvent[] = [
      { type: 'tool_event', taskId: 'T1', attempt: 1, tool: { at: 'now', name: 'Bash', detail: 'npm test' } },
    ];
    expect(collect(events)).toBe('');
    expect(collect(events, true)).toContain('Bash');
  });

  it('emits one JSON object per event under --jsonl, and no prose', () => {
    const out = collect(
      [
        { type: 'phase', taskId: 'T1', attempt: 1, phase: 'builder' },
        { type: 'task_done', taskId: 'T1', status: 'done', commit: 'abcdef1234' },
      ],
      false,
      true,
    );
    const lines = out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l['type'])).toEqual(['phase', 'task_done']);
    expect(lines[0]?.['at']).toBeTruthy();
  });

  it('keeps the output firehose out of --jsonl unless asked for it', () => {
    const event: RunnerEvent = {
      type: 'output',
      taskId: 'T1',
      attempt: 1,
      phase: 'gate',
      name: 'test',
      stream: 'stdout',
      chunk: 'noise\n',
    };
    expect(collect([event], false, true)).toBe('');
    expect(collect([event], true, true)).toContain('"type":"output"');
  });
});
