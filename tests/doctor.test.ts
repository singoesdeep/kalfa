import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { headToken, probeCli, resolveExecutable, runDoctor } from '../src/doctor/doctor.js';
import type { Check, ProbeResult } from '../src/doctor/doctor.js';

describe('headToken', () => {
  it('extracts the first word of a simple command', () => {
    expect(headToken('npm run typecheck')).toBe('npm');
  });

  it('trims surrounding whitespace', () => {
    expect(headToken('  pytest -q  ')).toBe('pytest');
  });

  it('stops at a pipe', () => {
    expect(headToken('tsc --noEmit | tee log')).toBe('tsc');
  });

  it('returns undefined for an inline env assignment', () => {
    expect(headToken('CI=1 npm test')).toBeUndefined();
  });

  it('returns undefined for a quoted head token', () => {
    expect(headToken('"C:/Program Files/x/tsc.exe"')).toBeUndefined();
  });

  it('returns undefined for the empty string', () => {
    expect(headToken('')).toBeUndefined();
  });

  it('returns undefined for a whitespace-only string', () => {
    expect(headToken('   ')).toBeUndefined();
  });

  it('does not choke on a $ in a later token', () => {
    expect(headToken('echo $HOME')).toBe('echo');
  });

  it('keeps a relative path token intact', () => {
    expect(headToken('./scripts/check.sh')).toBe('./scripts/check.sh');
  });
});

describe('resolveExecutable', () => {
  let dir: string;
  const originalPath = process.env.PATH;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    process.env.PATH = originalPath;
  });

  it('resolves a relative path token to an existing file', () => {
    dir = mkdtempSync(join(tmpdir(), 'kalfa-doctor-'));
    const file = join(dir, 'tool.txt');
    writeFileSync(file, 'x');
    const result = resolveExecutable('./tool.txt', dir);
    expect(result).toBe(join(dir, 'tool.txt'));
  });

  it('returns undefined when the path token points at a directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'kalfa-doctor-'));
    const sub = join(dir, 'subdir');
    mkdirSync(sub);
    expect(resolveExecutable('./subdir', dir)).toBeUndefined();
  });

  it('returns undefined for an unknown token when PATH is empty', () => {
    dir = mkdtempSync(join(tmpdir(), 'kalfa-doctor-'));
    process.env.PATH = '';
    expect(resolveExecutable('definitely-not-a-real-binary', dir)).toBeUndefined();
  });

  it('finds a file placed in a directory prepended to PATH', () => {
    dir = mkdtempSync(join(tmpdir(), 'kalfa-doctor-'));
    if (process.platform === 'win32') {
      const file = join(dir, 'mytool.CMD');
      writeFileSync(file, '@echo off');
      process.env.PATH = dir + delimiter + (originalPath ?? '');
      expect(resolveExecutable('mytool', dir)).toBe(file);
    } else {
      const file = join(dir, 'mytool');
      writeFileSync(file, '#!/bin/sh\n');
      process.env.PATH = dir + delimiter + (originalPath ?? '');
      expect(resolveExecutable('mytool', dir)).toBe(file);
    }
  });

  it('resolves a relative PATH entry against cwd and returns an absolute path', () => {
    dir = mkdtempSync(join(tmpdir(), 'kalfa-doctor-'));
    const sub = join(dir, 'bin');
    mkdirSync(sub);
    if (process.platform === 'win32') {
      const file = join(sub, 'mytool.CMD');
      writeFileSync(file, '@echo off');
      process.env.PATH = 'bin' + delimiter + (originalPath ?? '');
      const result = resolveExecutable('mytool', dir);
      expect(result).toBe(file);
    } else {
      const file = join(sub, 'mytool');
      writeFileSync(file, '#!/bin/sh\n');
      process.env.PATH = 'bin' + delimiter + (originalPath ?? '');
      const result = resolveExecutable('mytool', dir);
      expect(result).toBe(file);
    }
  });
});

describe('probeCli', () => {
  it('resolves with found: false for a nonexistent binary', async () => {
    const result = await probeCli('kalfa-definitely-not-a-real-binary-xyz');
    expect(result).toEqual({ found: false });
  });

  it(
    'resolves with found: true and a version string for node',
    async () => {
      const result = await probeCli('node');
      expect(result.found).toBe(true);
      expect(result.version).toBeDefined();
      expect(result.version?.startsWith('v')).toBe(true);
    },
    20000,
  );

  it('resolves with found: false instead of rejecting when spawn throws synchronously', async () => {
    // A NUL byte makes Node's spawn() throw synchronously inside the
    // Promise executor rather than emitting an 'error' event.
    const result = await probeCli(`bad${String.fromCharCode(0)}binary`);
    expect(result).toEqual({ found: false });
  });
});
