import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolve } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSshWorkDirSpec, resolveNewSessionWorkDir, sameWorkDir } from '#/tui/utils/workdir-spec';

describe('isSshWorkDirSpec', () => {
  it('detects ssh:// specs case-insensitively', () => {
    expect(isSshWorkDirSpec('ssh://host/path')).toBe(true);
    expect(isSshWorkDirSpec('SSH://host/path')).toBe(true);
    expect(isSshWorkDirSpec('ssh://user@host:22/path')).toBe(true);
    expect(isSshWorkDirSpec('/local/path')).toBe(false);
    expect(isSshWorkDirSpec('ssh-host/path')).toBe(false);
    expect(isSshWorkDirSpec('')).toBe(false);
  });
});

describe('resolveNewSessionWorkDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kimi-new-spec-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the current workdir for empty or whitespace specs', () => {
    expect(resolveNewSessionWorkDir(undefined, root)).toEqual({ kind: 'current' });
    expect(resolveNewSessionWorkDir('', root)).toEqual({ kind: 'current' });
    expect(resolveNewSessionWorkDir('   ', root)).toEqual({ kind: 'current' });
  });

  it('detects ssh specs without touching the filesystem', () => {
    expect(resolveNewSessionWorkDir('ssh://host/path', '/definitely/not/a/dir')).toEqual({
      kind: 'ssh',
    });
    expect(resolveNewSessionWorkDir('SSH://host', '/definitely/not/a/dir')).toEqual({
      kind: 'ssh',
    });
  });

  it('resolves relative paths against the current workdir', () => {
    mkdirSync(join(root, 'sub'));

    expect(resolveNewSessionWorkDir('sub', root)).toEqual({
      kind: 'local',
      workDir: resolve(root, 'sub'),
    });
    expect(resolveNewSessionWorkDir('./sub', root)).toEqual({
      kind: 'local',
      workDir: resolve(root, 'sub'),
    });
    expect(resolveNewSessionWorkDir('sub/../sub', root)).toEqual({
      kind: 'local',
      workDir: resolve(root, 'sub'),
    });
  });

  it('accepts absolute paths and normalizes them', () => {
    expect(resolveNewSessionWorkDir(root, '/unrelated')).toEqual({
      kind: 'local',
      workDir: resolve(root),
    });
    expect(resolveNewSessionWorkDir(join(root, '.'), '/unrelated')).toEqual({
      kind: 'local',
      workDir: resolve(root),
    });
  });

  it('expands a leading ~ to the home directory', () => {
    expect(resolveNewSessionWorkDir('~', root)).toEqual({
      kind: 'local',
      workDir: resolve(homedir()),
    });
  });

  it('expands ~/... specs before resolving (error shows the expanded target)', () => {
    const result = resolveNewSessionWorkDir('~/kimi-code-test-missing-dir', root);

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toBe(
        `Directory not found: ${resolve(homedir(), 'kimi-code-test-missing-dir')}`,
      );
    }
  });

  it('reports a nonexistent directory', () => {
    const result = resolveNewSessionWorkDir('missing-dir', root);

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toBe(`Directory not found: ${resolve(root, 'missing-dir')}`);
    }
  });

  it('reports paths that are not directories', () => {
    writeFileSync(join(root, 'file.txt'), 'x');

    const result = resolveNewSessionWorkDir('file.txt', root);

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toBe(`Not a directory: ${resolve(root, 'file.txt')}`);
    }
  });
});

describe('sameWorkDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kimi-same-workdir-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('compares ssh specs verbatim when either side is an ssh workdir', () => {
    expect(sameWorkDir('ssh://gpucluster/work', 'ssh://gpucluster/work')).toBe(true);
    expect(sameWorkDir('ssh://gpucluster/work', 'ssh://gpucluster/other')).toBe(false);
    // Stored ssh workdirs are canonical; a differently-cased or unnormalized
    // spec is a different session.
    expect(sameWorkDir('ssh://GPUCLUSTER/work', 'ssh://gpucluster/work')).toBe(false);
    expect(sameWorkDir('ssh://gpucluster/work/', 'ssh://gpucluster/work')).toBe(false);
    expect(sameWorkDir('ssh://gpucluster/work', root)).toBe(false);
    expect(sameWorkDir(root, 'ssh://gpucluster/work')).toBe(false);
  });

  it('keeps the resolved-path comparison for local paths', () => {
    expect(sameWorkDir(join(root, 'sub', '..'), root)).toBe(true);
    expect(sameWorkDir(root, join(root, 'other'))).toBe(false);
  });
});
