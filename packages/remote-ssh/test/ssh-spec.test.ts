import { describe, expect, it } from 'vitest';

import {
  RemoteSshValueError,
  canonicalizeSshWorkDirSpec,
  formatSshWorkDirSpec,
  isSshWorkDirSpec,
  parseSshWorkDirSpec,
} from '#/ssh-spec';

describe('isSshWorkDirSpec', () => {
  it('detects ssh:// specs case-insensitively', () => {
    expect(isSshWorkDirSpec('ssh://host/dir')).toBe(true);
    expect(isSshWorkDirSpec('SSH://host/dir')).toBe(true);
    expect(isSshWorkDirSpec('/local/path')).toBe(false);
    expect(isSshWorkDirSpec('C:/Users/me')).toBe(false);
    expect(isSshWorkDirSpec('ssh:/host')).toBe(false);
  });
});

describe('parseSshWorkDirSpec', () => {
  it('parses a full spec', () => {
    expect(parseSshWorkDirSpec('ssh://user@Host:2222/home/user/proj/')).toEqual({
      host: 'Host',
      user: 'user',
      port: 2222,
      path: '/home/user/proj',
    });
  });

  it('parses a minimal alias spec', () => {
    expect(parseSshWorkDirSpec('ssh://gpu08/data')).toEqual({
      host: 'gpu08',
      user: undefined,
      port: undefined,
      path: '/data',
    });
  });

  it('tolerates an empty port segment', () => {
    expect(parseSshWorkDirSpec('ssh://Host:/data')).toEqual({
      host: 'Host',
      user: undefined,
      port: undefined,
      path: '/data',
    });
    expect(canonicalizeSshWorkDirSpec('ssh://Host:/data')).toBe('ssh://Host/data');
  });

  it('accepts the root path', () => {
    expect(parseSshWorkDirSpec('ssh://host/')).toEqual({
      host: 'host',
      user: undefined,
      port: undefined,
      path: '/',
    });
  });

  it('normalizes dot segments and duplicate slashes in the path', () => {
    expect(parseSshWorkDirSpec('ssh://host/data/x/../y').path).toBe('/data/y');
    expect(parseSshWorkDirSpec('ssh://host/a//b').path).toBe('/a/b');
  });

  it.each([
    ['not an ssh spec', '/local/path'],
    ['missing path', 'ssh://host'],
    ['empty host', 'ssh:///x'],
    ['query', 'ssh://host/d?x=1'],
    ['fragment', 'ssh://host/d#x'],
    ['non-numeric port', 'ssh://host:abc/d'],
    ['zero port', 'ssh://host:0/d'],
    ['port out of range', 'ssh://host:65536/d'],
    ['ipv6 literal', 'ssh://host:1:2/d'],
    ['empty user', 'ssh://@host/d'],
  ])('rejects %s', (_label, spec) => {
    expect(() => parseSshWorkDirSpec(spec)).toThrowError(RemoteSshValueError);
    expect(() => parseSshWorkDirSpec(spec)).toThrowError(/SSH workdir spec|ssh:\/\//);
  });
});

describe('canonicalizeSshWorkDirSpec', () => {
  it('lowercases the scheme, keeps the host verbatim, elides the default port, normalizes the path', () => {
    expect(canonicalizeSshWorkDirSpec('SSH://User@GPU08:22/data/x/../y')).toBe(
      'ssh://User@GPU08/data/y',
    );
  });

  it('keeps non-default ports and the user verbatim', () => {
    expect(canonicalizeSshWorkDirSpec('ssh://Me@Host:2222/d')).toBe('ssh://Me@Host:2222/d');
  });

  it('keeps the root path', () => {
    expect(canonicalizeSshWorkDirSpec('ssh://host/')).toBe('ssh://host/');
  });

  it('is idempotent', () => {
    const once = canonicalizeSshWorkDirSpec('ssh://User@Host:22/a/./b/');
    expect(canonicalizeSshWorkDirSpec(once)).toBe(once);
  });
});

describe('formatSshWorkDirSpec', () => {
  it('renders the canonical form of an already-parsed spec', () => {
    expect(formatSshWorkDirSpec({ host: 'GPU08', user: 'me', port: 22, path: '/data' })).toBe(
      'ssh://me@GPU08/data',
    );
    expect(formatSshWorkDirSpec({ host: 'gpu08', path: '/' })).toBe('ssh://gpu08/');
    expect(formatSshWorkDirSpec({ host: 'gpu08', port: 2222, path: '/d' })).toBe(
      'ssh://gpu08:2222/d',
    );
  });
});
