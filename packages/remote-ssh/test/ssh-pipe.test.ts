import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RtsError } from '#/client/client';
import {
  REMOTE_BIN_DEPLOY_COMMAND,
  REMOTE_BIN_PIPE_COMMAND,
  REMOTE_BIN_VERSION_COMMAND,
  REMOTE_DEPLOY_COMMAND,
  REMOTE_PIPE_COMMAND,
  deployTimeoutForBytes,
  parseUnamePlatform,
  readLocalSeaBinary,
} from '#/client/deploy';
import {
  RemoteBlockedError,
  SshPipeClient,
  type SshPipeOptions,
  type SshPipeState,
} from '#/client/sshPipeClient';

import { makeTempDir, removeTempDir, waitForCondition } from './helpers';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const rtsBundle = join(packageRoot, 'dist', 'rts.js');
const fakeSshPath = fileURLToPath(new URL('helpers/fakeSsh.mjs', import.meta.url));

const ENV_KEYS = [
  'FAKE_SSH_HOME',
  'FAKE_SSH_ARGV_LOG',
  'FAKE_SSH_NO_NODE',
  'FAKE_SSH_STDOUT_DELAY_MS',
  'FAKE_SSH_UNAME',
  'FAKE_SSH_RTS_BUNDLE',
] as const;

let savedEnv: (string | undefined)[];
let fakeHome: string;
let argvLogPath: string;

/**
 * Hermetic ssh end-to-end suite: the client's `sshPath` is the local node
 * binary and the first "ssh arg" is the fake client script, which emulates
 * the remote side against a tmp-dir $HOME and runs the real RTS bundle for
 * the pipe. No real ssh binary, HOME, or network is involved.
 */
describe('SshPipeClient over fake ssh', () => {
  beforeAll(() => {
    execSync('pnpm run build', { cwd: packageRoot, stdio: 'pipe' });
  }, 120_000);

  beforeEach(async () => {
    savedEnv = ENV_KEYS.map(key => process.env[key]);
    fakeHome = await makeTempDir();
    argvLogPath = join(fakeHome, 'argv.log');
    process.env['FAKE_SSH_HOME'] = fakeHome;
    process.env['FAKE_SSH_ARGV_LOG'] = argvLogPath;
    // The binary flavor's stand-in: the fake never executes the uploaded
    // rts-bin bytes, it bridges the real bundle instead.
    process.env['FAKE_SSH_RTS_BUNDLE'] = rtsBundle;
    delete process.env['FAKE_SSH_NO_NODE'];
    delete process.env['FAKE_SSH_STDOUT_DELAY_MS'];
    delete process.env['FAKE_SSH_UNAME'];
  });

  afterEach(async () => {
    ENV_KEYS.forEach((key, index) => {
      const value = savedEnv[index];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
    await removeTempDir(fakeHome);
  });

  function fakeOptions(extra?: Partial<SshPipeOptions>): SshPipeOptions {
    return {
      sshPath: process.execPath,
      sshArgs: [fakeSshPath],
      // Never read the real ~/.ssh/config.
      sshConfigPath: join(fakeHome, 'ssh-config-missing'),
      // An empty seaDir keeps auto mode deterministic: no artifact, so the
      // script flavor runs unless a test opts into a fixture.
      seaDir: join(fakeHome, 'sea-empty'),
      reconnectBackoffMs: [10, 20, 50],
      connectTimeoutMs: 10_000,
      ...extra,
    };
  }

  interface FakeInvocation {
    args: string[];
    command: string;
  }

  function readInvocations(): FakeInvocation[] {
    if (!existsSync(argvLogPath)) return [];
    return readFileSync(argvLogPath, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => {
        const args = JSON.parse(line) as string[];
        return { args, command: args.at(-1) ?? '' };
      });
  }

  function deployCount(): number {
    return readInvocations().filter(invocation =>
      invocation.command.startsWith('mkdir -p '),
    ).length;
  }

  function pipeInvocations(): FakeInvocation[] {
    return readInvocations().filter(invocation => invocation.command === REMOTE_PIPE_COMMAND);
  }

  function binPipeInvocations(): FakeInvocation[] {
    return readInvocations().filter(invocation => invocation.command === REMOTE_BIN_PIPE_COMMAND);
  }

  function deployedBundlePath(): string {
    return join(fakeHome, '.kimi-code', 'remote-agent', 'rts.js');
  }

  /** A sea/ fixture holding a dummy linux-x64 rts-bin (never executed by the fake). */
  async function makeSeaFixture(): Promise<string> {
    const dir = await makeTempDir();
    mkdirSync(join(dir, 'linux-x64'), { recursive: true });
    writeFileSync(join(dir, 'linux-x64', 'rts-bin'), 'fake rts binary fixture\n');
    return dir;
  }

  it('first connect deploys the bundle and serves fs calls', async () => {
    const client = await SshPipeClient.connect('ssh://fakehost/tmp/x', fakeOptions());
    try {
      expect(client.state).toBe('ready');
      expect(client.spec).toBe('ssh://fakehost/tmp/x');
      expect(client.facts.shellName).toBe('bash');
      expect(deployCount()).toBe(1);
      expect(pipeInvocations()).toHaveLength(1);
      expect(existsSync(deployedBundlePath())).toBe(true);

      const workDir = await makeTempDir();
      try {
        const file = join(workDir, 'hello.txt');
        await client.fs.writeText(file, 'hello over ssh');
        expect(await client.fs.readText(file)).toBe('hello over ssh');
      } finally {
        await removeTempDir(workDir);
      }
    } finally {
      await client.close();
    }
    expect(client.state).toBe('closed');
  });

  it('rejects relative fs paths and spawn cwd with EINVAL', async () => {
    const client = await SshPipeClient.connect('ssh://fakehost/tmp/x', fakeOptions());
    try {
      // A relative path must never reach the remote fs: the server would
      // otherwise silently resolve it against the RTS process cwd (the
      // remote home), writing or reading an unintended tree.
      await expect(client.fs.writeText('relative/file.txt', 'x')).rejects.toMatchObject({
        code: 'EINVAL',
      });
      await expect(client.fs.readText('relative/file.txt')).rejects.toMatchObject({
        code: 'EINVAL',
      });
      await expect(client.fs.stat('relative')).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(client.fs.mkdir('relative')).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(client.fs.remove('relative')).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(client.fs.exists('relative')).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(client.fs.realpath('relative')).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(client.fs.readBytes('relative')).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(client.fs.readLines('relative')).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(client.fs.readdir('relative')).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(client.fs.glob('relative', '*.txt')).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(
        client.spawn({ cmd: 'bash', args: ['-c', 'true'], cwd: 'relative' }),
      ).rejects.toMatchObject({ code: 'EINVAL' });
    } finally {
      await client.close();
    }
  });

  it('second connect skips the deploy when the remote version matches', async () => {
    const first = await SshPipeClient.connect('ssh://fakehost/tmp/x', fakeOptions());
    await first.close();
    expect(deployCount()).toBe(1);

    // The object form of the spec routes the same way.
    const second = await SshPipeClient.connect({ host: 'fakehost', path: '/tmp/x' }, fakeOptions());
    try {
      expect(second.state).toBe('ready');
      expect(second.spec).toBe('ssh://fakehost/tmp/x');
      expect(deployCount()).toBe(1);
      expect(await second.fs.exists(fakeHome)).toBe(true);
    } finally {
      await second.close();
    }
  });

  it('redeploys when the remote bundle version is stale', async () => {
    const first = await SshPipeClient.connect('ssh://fakehost/tmp/x', fakeOptions());
    await first.close();
    expect(deployCount()).toBe(1);

    // A stale bundle still answers --version, just with the wrong version.
    writeFileSync(deployedBundlePath(), "process.stdout.write('0.0.0-stale\\n');\n");

    const second = await SshPipeClient.connect('ssh://fakehost/tmp/x', fakeOptions());
    try {
      expect(second.state).toBe('ready');
      expect(deployCount()).toBe(2);
      // The real bundle is back in place and serves calls.
      expect(readFileSync(deployedBundlePath()).equals(readFileSync(rtsBundle))).toBe(true);
      const workDir = await makeTempDir();
      try {
        const file = join(workDir, 'stale.txt');
        await second.fs.writeText(file, 'fresh');
        expect(await second.fs.readText(file)).toBe('fresh');
      } finally {
        await removeTempDir(workDir);
      }
    } finally {
      await second.close();
    }
  });

  it('rejects the first connect when the remote has no usable node', async () => {
    process.env['FAKE_SSH_NO_NODE'] = '1';
    const attempt = SshPipeClient.connect('ssh://fakehost/tmp/x', fakeOptions());
    await expect(attempt).rejects.toThrowError(/node >= 20/);
    await expect(attempt).rejects.toThrowError(/command not found/);
  });

  it('fails with a build hint when the local bundle is missing', async () => {
    const attempt = SshPipeClient.connect(
      'ssh://fakehost/tmp/x',
      fakeOptions({ bundlePath: join(fakeHome, 'no-such-rts.js') }),
    );
    await expect(attempt).rejects.toThrowError(/remote-ssh build/);
  });

  it('auto + local binary artifact deploys and pipes the binary flavor', async () => {
    const seaDir = await makeSeaFixture();
    try {
      const client = await SshPipeClient.connect('ssh://fakehost/tmp/x', fakeOptions({ seaDir }));
      try {
        expect(client.state).toBe('ready');
        const invocations = readInvocations();
        // The uname probe runs first on every connect.
        expect(invocations[0]?.command).toBe('uname -sm');
        // The binary version probe uses --rts-version, then the binary upload.
        expect(invocations.some(invocation => invocation.command === REMOTE_BIN_VERSION_COMMAND)).toBe(
          true,
        );
        const deploys = invocations.filter(invocation => invocation.command.startsWith('mkdir -p '));
        expect(deploys).toHaveLength(1);
        expect(deploys[0]!.command).toBe(REMOTE_BIN_DEPLOY_COMMAND);
        // The node script flavor never ran: no node probe, no rts.js deploy.
        expect(invocations.some(invocation => invocation.command === 'node --version')).toBe(false);
        expect(pipeInvocations()).toHaveLength(0);
        // The pipe's remote command tail is the binary path.
        const bins = binPipeInvocations();
        expect(bins).toHaveLength(1);
        expect(bins[0]!.args.at(-1)).toBe(REMOTE_BIN_PIPE_COMMAND);
        // Calls flow over the binary pipe.
        const workDir = await makeTempDir();
        try {
          const file = join(workDir, 'bin.txt');
          await client.fs.writeText(file, 'via binary');
          expect(await client.fs.readText(file)).toBe('via binary');
        } finally {
          await removeTempDir(workDir);
        }
      } finally {
        await client.close();
      }
    } finally {
      await removeTempDir(seaDir);
    }
  });

  it('auto without a local artifact keeps the script flavor', async () => {
    const client = await SshPipeClient.connect('ssh://fakehost/tmp/x', fakeOptions());
    try {
      expect(client.state).toBe('ready');
      const invocations = readInvocations();
      expect(invocations[0]?.command).toBe('uname -sm');
      // The script probe/deploy/pipe sequence follows, byte-identical to before.
      expect(invocations.some(invocation => invocation.command === 'node --version')).toBe(true);
      const deploys = invocations.filter(invocation => invocation.command.startsWith('mkdir -p '));
      expect(deploys).toHaveLength(1);
      expect(deploys[0]!.command).toBe(REMOTE_DEPLOY_COMMAND);
      expect(invocations.some(invocation => invocation.command.includes('rts-bin'))).toBe(false);
      expect(pipeInvocations()).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("deployMode 'binary' without a local artifact rejects with build instructions", async () => {
    const attempt = SshPipeClient.connect(
      'ssh://fakehost/tmp/x',
      fakeOptions({ deployMode: 'binary' }),
    );
    await expect(attempt).rejects.toThrowError(/build:sea/);
  });

  it("deployMode 'script' ignores a local binary artifact", async () => {
    const seaDir = await makeSeaFixture();
    try {
      const client = await SshPipeClient.connect(
        'ssh://fakehost/tmp/x',
        fakeOptions({ deployMode: 'script', seaDir }),
      );
      try {
        expect(client.state).toBe('ready');
        const invocations = readInvocations();
        expect(invocations.some(invocation => invocation.command.includes('rts-bin'))).toBe(false);
        expect(invocations.some(invocation => invocation.command === 'node --version')).toBe(true);
        const deploys = invocations.filter(invocation => invocation.command.startsWith('mkdir -p '));
        expect(deploys).toHaveLength(1);
        expect(deploys[0]!.command).toBe(REMOTE_DEPLOY_COMMAND);
        expect(pipeInvocations()).toHaveLength(1);
      } finally {
        await client.close();
      }
    } finally {
      await removeTempDir(seaDir);
    }
  });

  it('builds the ssh argv from the spec: -T, BatchMode, port, user@host', async () => {
    const client = await SshPipeClient.connect('ssh://alice@fakehost:2222/tmp/x', fakeOptions());
    try {
      expect(client.spec).toBe('ssh://alice@fakehost:2222/tmp/x');
      const pipes = pipeInvocations();
      expect(pipes).toHaveLength(1);
      const argv = pipes[0]!.args;
      expect(argv).toContain('-T');
      expect(argv).toContain('BatchMode=yes');
      expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
      expect(argv).toContain('alice@fakehost');
      expect(argv.at(-1)).toBe(REMOTE_PIPE_COMMAND);
      // One-shot execs (probe/deploy) carry BatchMode too.
      const probe = readInvocations().find(invocation => invocation.command === 'node --version');
      expect(probe?.args).toContain('BatchMode=yes');
    } finally {
      await client.close();
    }
  });

  it('keeps the Host alias as the ssh destination so config stanzas still match', async () => {
    // A config stanza carrying HostName/User/Port (and, in real setups,
    // IdentityFile/ProxyJump) only applies when the spawned ssh is given the
    // alias; resolving HostName client-side would bypass the stanza and drop
    // key auth. Regression test for `Permission denied (publickey)` on hosts
    // whose keys come from ~/.ssh/config.
    const configPath = join(fakeHome, 'ssh-config');
    writeFileSync(
      configPath,
      ['Host fakehost', '  HostName 192.0.2.10', '  User bob', '  Port 32253', ''].join('\n'),
    );
    const client = await SshPipeClient.connect(
      'ssh://fakehost/tmp/x',
      fakeOptions({ sshConfigPath: configPath }),
    );
    try {
      const argv = pipeInvocations()[0]!.args;
      expect(argv).toContain('bob@fakehost');
      expect(argv).not.toContain('bob@192.0.2.10');
      expect(argv).not.toContain('192.0.2.10');
      expect(argv[argv.indexOf('-p') + 1]).toBe('32253');
    } finally {
      await client.close();
    }
  });

  it('pipe loss rejects in-flight calls, reconnects into blocked, and resume() restores service', async () => {
    // The fake delays server→client bytes by 500 ms, so the call below is
    // still in flight when the remote "crashes" 150 ms after starting.
    process.env['FAKE_SSH_STDOUT_DELAY_MS'] = '500';
    const states: SshPipeState[] = [];
    const client = await SshPipeClient.connect(
      'ssh://fakehost/tmp/x',
      fakeOptions({
        onStateChange: state => {
          states.push(state);
        },
      }),
    );

    const workDir = await makeTempDir();
    try {
      const file = join(workDir, 'before-loss.txt');
      await client.fs.writeText(file, 'before loss');

      // The spawned remote process SIGKILLs its parent — the RTS server.
      const pending = client.spawn({
        cmd: process.execPath,
        args: ['-e', 'setTimeout(() => process.kill(process.ppid, "SIGKILL"), 150)'],
      });
      const pendingError: Error = await pending.then(
        () => {
          throw new Error('the in-flight call should have rejected');
        },
        (error: Error) => error,
      );
      expect(pendingError).toBeInstanceOf(RtsError);
      expect((pendingError as RtsError).code).toBe('ECLOSED');

      // Background reconnect: probe + version match (no redeploy) + new pipe.
      await waitForCondition(() => client.state === 'blocked', 10_000);
      expect(states).toContain('disconnected');
      expect(states).toContain('reconnecting');
      expect(deployCount()).toBe(1);
      expect(pipeInvocations()).toHaveLength(2);

      // Blocked: every op fails fast with EBLOCKED; nothing is glossed over.
      const blockedAttempts: Array<() => Promise<unknown>> = [
        () => client.call('fs.exists', { path: file }),
        () => client.fs.exists(file),
        () => client.spawn({ cmd: process.execPath, args: ['-e', ''] }),
      ];
      for (const attempt of blockedAttempts) {
        const error: Error = await attempt().then(
          () => {
            throw new Error('expected an EBLOCKED rejection');
          },
          (blockedError: Error) => blockedError,
        );
        expect(error).toBeInstanceOf(RemoteBlockedError);
        expect((error as RemoteBlockedError).code).toBe('EBLOCKED');
      }

      // resume() acknowledges the interruption and restores service.
      await client.resume();
      expect(client.state).toBe('ready');
      expect(await client.fs.readText(file)).toBe('before loss');
    } finally {
      await client.close();
      await removeTempDir(workDir);
    }
  });

  it('resume() throws unless the client is blocked', async () => {
    const client = await SshPipeClient.connect('ssh://fakehost/tmp/x', fakeOptions());
    try {
      await expect(client.resume()).rejects.toThrowError(/blocked state/);
    } finally {
      await client.close();
    }
    await expect(client.resume()).rejects.toThrowError(/blocked state/);
  });

  it('a call made while disconnected reconnects once on demand instead of failing fast', async () => {
    const states: SshPipeState[] = [];
    const client = await SshPipeClient.connect(
      'ssh://fakehost/tmp/x',
      fakeOptions({
        // The long backoff keeps the background reconnect pending; the
        // on-demand path must cancel that timer and reconnect immediately.
        reconnectBackoffMs: [60_000],
        onStateChange: state => {
          states.push(state);
        },
      }),
    );

    const workDir = await makeTempDir();
    try {
      const file = join(workDir, 'survives-loss.txt');
      await client.fs.writeText(file, 'still here');

      // Kill the RTS server from inside a spawned remote process; the pipe
      // drops and the client parks in disconnected with the timer pending.
      const killer = await client.spawn({
        cmd: process.execPath,
        args: ['-e', 'setTimeout(() => process.kill(process.ppid, "SIGKILL"), 100)'],
      });
      void killer.wait().catch(() => {});
      await waitForCondition(() => client.state === 'disconnected', 10_000);

      // The next call reconnects once on demand and succeeds; the
      // successful reconnect is auto-resumed for the calling op.
      expect(await client.fs.readText(file)).toBe('still here');
      expect(client.state).toBe('ready');
      expect(states).toContain('reconnecting');
      expect(states).toContain('blocked');
      expect(deployCount()).toBe(1);
      expect(pipeInvocations()).toHaveLength(2);
    } finally {
      await client.close();
      await removeTempDir(workDir);
    }
  });

  it('a call made while disconnected still rejects when the on-demand reconnect fails', async () => {
    const client = await SshPipeClient.connect(
      'ssh://fakehost/tmp/x',
      fakeOptions({ reconnectBackoffMs: [60_000] }),
    );
    try {
      const killer = await client.spawn({
        cmd: process.execPath,
        args: ['-e', 'setTimeout(() => process.kill(process.ppid, "SIGKILL"), 100)'],
      });
      void killer.wait().catch(() => {});
      await waitForCondition(() => client.state === 'disconnected', 10_000);

      // The reconnect probe now finds no usable node on the remote, so the
      // single on-demand attempt fails and the call rejects with EBLOCKED.
      process.env['FAKE_SSH_NO_NODE'] = '1';
      const error: Error = await client.fs.exists('/x').then(
        () => {
          throw new Error('expected an EBLOCKED rejection');
        },
        (blockedError: Error) => blockedError,
      );
      expect(error).toBeInstanceOf(RemoteBlockedError);
      expect((error as RemoteBlockedError).code).toBe('EBLOCKED');
      expect(client.state).toBe('disconnected');
    } finally {
      delete process.env['FAKE_SSH_NO_NODE'];
      await client.close();
    }
  });

  it('close() is idempotent and no reconnect happens after close', async () => {
    const client = await SshPipeClient.connect('ssh://fakehost/tmp/x', fakeOptions());
    await client.close();
    await client.close();
    expect(client.state).toBe('closed');

    const invocationCount = readInvocations().length;
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(readInvocations()).toHaveLength(invocationCount);

    await expect(client.fs.exists('/x')).rejects.toThrowError(/closed/);
  });
});

describe('parseUnamePlatform', () => {
  it.each([
    ['Linux x86_64', 'linux-x64'],
    ['Linux amd64', 'linux-x64'],
    ['Linux aarch64', 'linux-arm64'],
    ['Linux arm64', 'linux-arm64'],
    ['Darwin x86_64', 'darwin-x64'],
    ['Darwin arm64', 'darwin-arm64'],
    ['linux x86_64', 'linux-x64'],
    ['FreeBSD amd64', null],
    ['Linux', null],
    ['Linux riscv64', null],
    ['garbage', null],
    ['', null],
  ])('maps %j to %j', (input, expected) => {
    expect(parseUnamePlatform(input)).toBe(expected);
  });
});

describe('readLocalSeaBinary', () => {
  let savedKimiHome: string | undefined;
  let kimiHome: string;

  beforeEach(async () => {
    savedKimiHome = process.env['KIMI_CODE_HOME'];
    kimiHome = await makeTempDir();
    process.env['KIMI_CODE_HOME'] = kimiHome;
  });

  afterEach(async () => {
    if (savedKimiHome === undefined) delete process.env['KIMI_CODE_HOME'];
    else process.env['KIMI_CODE_HOME'] = savedKimiHome;
    await removeTempDir(kimiHome);
  });

  function plantHomeArtifact(platform: string, content: string): void {
    mkdirSync(join(kimiHome, 'sea', platform), { recursive: true });
    writeFileSync(join(kimiHome, 'sea', platform, 'rts-bin'), content);
  }

  it('prefers an explicit seaDir and never falls through', async () => {
    const dir = await makeTempDir();
    try {
      mkdirSync(join(dir, 'darwin-arm64'), { recursive: true });
      writeFileSync(join(dir, 'darwin-arm64', 'rts-bin'), 'from-seaDir');
      plantHomeArtifact('darwin-arm64', 'from-home');
      await expect(readLocalSeaBinary('darwin-arm64', dir)).resolves.toEqual(
        Buffer.from('from-seaDir'),
      );
      // Missing under the explicit dir: null, no home fallthrough.
      await expect(readLocalSeaBinary('linux-arm64', dir)).resolves.toBeNull();
    } finally {
      await removeTempDir(dir);
    }
  });

  it('falls back to the kimi home sea dir when the package tree has no artifact', async () => {
    // The repo sea/ holds no darwin-arm64 artifact, so the package walk-up
    // misses and the kimi-home copy serves it. (If a darwin-arm64 artifact
    // ever lands in the repo sea/, this test needs a different platform.)
    plantHomeArtifact('darwin-arm64', 'from-home');
    await expect(readLocalSeaBinary('darwin-arm64')).resolves.toEqual(Buffer.from('from-home'));
  });

  it('returns null when no location holds the platform artifact', async () => {
    await expect(readLocalSeaBinary('darwin-arm64')).resolves.toBeNull();
  });
});

describe('deployTimeoutForBytes', () => {
  it('scales ~1 MB/s plus a 60 s margin, floored at the base timeout', () => {
    // Small uploads: the flat margin dominates.
    expect(deployTimeoutForBytes(21 * 1024, 15_000)).toBe(61_000);
    // The 117 MiB RTS binary: ~117 s transfer budget + margin.
    expect(deployTimeoutForBytes(117 * 1024 * 1024, 15_000)).toBe(177_000);
    // A larger base timeout always wins.
    expect(deployTimeoutForBytes(1024 * 1024, 120_000)).toBe(120_000);
  });
});
