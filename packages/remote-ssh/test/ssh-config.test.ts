import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseSshConfig, resolveSshConnection } from '#/client/sshConfig';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'remote-ssh-config-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(content: string): string {
  const configPath = join(tempDir, 'config');
  writeFileSync(configPath, content);
  return configPath;
}

/**
 * Neutral fixture replicating the syntax shapes of a realistic power-user
 * config: tab separators, `key=value`, comments, wildcards + negation, and
 * unknown keywords that must be ignored.
 */
const REALISTIC_CONFIG = [
  '# Global defaults apply to every host',
  'ServerAliveInterval 60',
  '',
  'Host dev dev-alias',
  '\tHostName dev.internal.example.com',
  '\tUser=me',
  '\tPort 2222',
  '\tIdentityFile "~/.ssh/id_ed25519"',
  '\tProxyCommand ssh jump.example.com -W %h:%p',
  '',
  'Host gpu* !gpu-legacy',
  '    HostName 192.0.2.10',
  '    User user',
  '',
  'Host gpu-legacy',
  '    HostName 192.0.2.99',
  '',
  'Host *',
  '    User fallback',
  '    Port 22',
].join('\n');

describe('resolveSshConnection()', () => {
  it('resolves all-undefined when the config file is missing', () => {
    expect(resolveSshConnection('somehost', { configPath: join(tempDir, 'missing') })).toEqual({
      hostname: undefined,
      user: undefined,
      port: undefined,
    });
  });

  it('resolves a full stanza and ignores out-of-scope keywords', () => {
    const resolved = resolveSshConnection('dev', { configPath: writeConfig(REALISTIC_CONFIG) });
    expect(resolved.hostname).toBe('dev.internal.example.com');
    expect(resolved.user).toBe('me');
    expect(resolved.port).toBe(2222);
  });

  it('matches every pattern in a space-separated Host list', () => {
    const resolved = resolveSshConnection('dev-alias', {
      configPath: writeConfig(REALISTIC_CONFIG),
    });
    expect(resolved.hostname).toBe('dev.internal.example.com');
    expect(resolved.user).toBe('me');
  });

  it('applies wildcard patterns and lets `!` negation veto a stanza', () => {
    const configPath = writeConfig(REALISTIC_CONFIG);

    const gpu = resolveSshConnection('gpu-7', { configPath });
    expect(gpu.hostname).toBe('192.0.2.10');
    // First obtained value wins: `user` from the gpu* stanza beats `Host *`.
    expect(gpu.user).toBe('user');
    // `port` only appears in `Host *`, so it still applies.
    expect(gpu.port).toBe(22);

    // gpu-legacy is vetoed from the gpu* stanza by `!gpu-legacy`.
    const legacy = resolveSshConnection('gpu-legacy', { configPath });
    expect(legacy.hostname).toBe('192.0.2.99');
    expect(legacy.user).toBe('fallback');
  });

  it('falls back to `Host *` values when nothing else matches', () => {
    const resolved = resolveSshConnection('other.example.com', {
      configPath: writeConfig(REALISTIC_CONFIG),
    });
    expect(resolved.hostname).toBeUndefined();
    expect(resolved.user).toBe('fallback');
    expect(resolved.port).toBe(22);
  });

  it('handles CRLF line endings', () => {
    const configPath = writeConfig(REALISTIC_CONFIG.replaceAll('\n', '\r\n'));
    const resolved = resolveSshConnection('dev', { configPath });
    expect(resolved.hostname).toBe('dev.internal.example.com');
    expect(resolved.port).toBe(2222);
  });

  it('is case-insensitive for keywords and strips quotes', () => {
    const configPath = writeConfig(
      ['HOST mixed', 'HOSTNAME "quoted.example.com"', 'UsEr me', 'PORT=2200'].join('\n'),
    );
    const resolved = resolveSshConnection('mixed', { configPath });
    expect(resolved.hostname).toBe('quoted.example.com');
    expect(resolved.user).toBe('me');
    expect(resolved.port).toBe(2200);
  });

  it('matches Host patterns case-sensitively, like OpenSSH', () => {
    const configPath = writeConfig(
      ['Host GpuCluster', '    HostName gpu.internal.example.com'].join('\n'),
    );
    expect(resolveSshConnection('GpuCluster', { configPath }).hostname).toBe(
      'gpu.internal.example.com',
    );
    expect(resolveSshConnection('gpucluster', { configPath }).hostname).toBeUndefined();
    expect(resolveSshConnection('GPUCLUSTER', { configPath }).hostname).toBeUndefined();
  });

  it('honors first-value-wins across stanzas', () => {
    const configPath = writeConfig(
      ['Host fir*', '    User one', 'Host *', '    User two', '    Port 2222'].join('\n'),
    );
    const resolved = resolveSshConnection('first', { configPath });
    expect(resolved.user).toBe('one');
    expect(resolved.port).toBe(2222);
  });

  it('applies global (pre-Host) options to every host', () => {
    const configPath = writeConfig(
      ['User global', 'Host specific', '    HostName specific.example.com'].join('\n'),
    );
    expect(resolveSshConnection('specific', { configPath }).user).toBe('global');
  });

  it('ignores invalid Port values', () => {
    const configPath = writeConfig(['Host bad', '    Port notaport'].join('\n'));
    expect(resolveSshConnection('bad', { configPath }).port).toBeUndefined();
  });
});

describe('parseSshConfig()', () => {
  it('splits global and Host sections', () => {
    const sections = parseSshConfig(REALISTIC_CONFIG);
    // global + dev + gpu* + gpu-legacy + Host *
    expect(sections).toHaveLength(5);
    expect(sections[0]?.patterns).toBeUndefined();
    expect(sections[0]?.entries).toEqual([{ key: 'serveraliveinterval', value: '60' }]);
    expect(sections[1]?.patterns).toEqual(['dev', 'dev-alias']);
  });
});
