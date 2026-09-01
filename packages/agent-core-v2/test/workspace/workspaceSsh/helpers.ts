import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SshPipeOptions } from '@moonshot-ai/remote-ssh';

export const REMOTE_SSH_ROOT = fileURLToPath(new URL('../../../../remote-ssh', import.meta.url));
export const FAKE_SSH_PATH = fileURLToPath(new URL('helpers/fakeSsh.mjs', import.meta.url));
export const RTS_BUNDLE = join(REMOTE_SSH_ROOT, 'dist', 'rts.js');

export function buildRtsBundle(): void {
  if (existsSync(RTS_BUNDLE)) return;
  execSync('pnpm run build', { cwd: REMOTE_SSH_ROOT, stdio: 'pipe' });
}

export const BASH: string | undefined = (() => {
  const probe = spawnSync('bash', ['-c', 'true'], { stdio: 'ignore' });
  return probe.status === 0 ? 'bash' : undefined;
})();

export async function makeTempDir(prefix = 'v2-ssh-test-'): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface FakeSshEnv {
  readonly fakeHome: string;
  readonly options: SshPipeOptions;
  restore(): Promise<void>;
}

const ENV_KEYS = [
  'FAKE_SSH_HOME',
  'FAKE_SSH_ARGV_LOG',
  'FAKE_SSH_NO_NODE',
  'FAKE_SSH_STDOUT_DELAY_MS',
] as const;

export async function fakeSshEnv(extra?: Partial<SshPipeOptions>): Promise<FakeSshEnv> {
  const savedEnv = ENV_KEYS.map((key) => process.env[key]);
  const fakeHome = await makeTempDir();
  process.env['FAKE_SSH_HOME'] = fakeHome;
  delete process.env['FAKE_SSH_NO_NODE'];
  delete process.env['FAKE_SSH_STDOUT_DELAY_MS'];
  return {
    fakeHome,
    options: {
      sshPath: process.execPath,
      sshArgs: [FAKE_SSH_PATH],
      sshConfigPath: join(fakeHome, 'ssh-config-missing'),
      reconnectBackoffMs: [10, 20, 50],
      connectTimeoutMs: 10_000,
      ...extra,
    },
    restore: async () => {
      ENV_KEYS.forEach((key, index) => {
        const value = savedEnv[index];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
      await removeTempDir(fakeHome);
    },
  };
}
