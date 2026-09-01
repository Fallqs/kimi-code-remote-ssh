/* oxlint-disable eslint-plugin-jest/no-standalone-expect -- itBash wraps it, so expects inside itBash blocks are legitimate. */
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { LifecycleScope } from '#/app/scopes';
import { IEventService } from '#/app/event/event';
import { IFlagService } from '#/app/flag/flag';
import { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import { FileWorkspacePersistence } from '#/app/workspace/fileWorkspacePersistence';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { WorkspaceService } from '#/app/workspace/workspaceService';
import { ErrorCodes } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { Runtime } from '#/runtime/runtime';
import type { RuntimeProviderHost } from '#/runtime/runtimeUnitHost';
import { LocalRuntimeProviderFactory } from '#/runtime/localRuntime';
import { SSH_WORKDIR_FLAG_ID } from '#/workspace/workspaceSsh/flag';
import { SshRuntime } from '#/workspace/workspaceSsh/sshRuntime';
import { SshRuntimeProviderFactory } from '#/workspace/workspaceSsh/sshRuntimeProvider';

import { BASH, buildRtsBundle, fakeSshEnv, type FakeSshEnv } from './helpers';

const itBash = BASH === undefined ? it.skip : it;

function fakeHost(flagEnabled: boolean, captured: { runtime?: Runtime }): RuntimeProviderHost {
  return {
    get: (id: unknown) => {
      if (id === (IFlagService as unknown)) {
        return { enabled: (flag: string) => flag === SSH_WORKDIR_FLAG_ID && flagEnabled };
      }
      throw new Error('unexpected host.get');
    },
    provide: () => {
      throw new Error('unexpected host.provide');
    },
    registerRuntime: (runtime: Runtime) => {
      captured.runtime = runtime;
      return {
        runtimeId: runtime.identity.runtimeId,
        update: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      };
    },
  } as unknown as RuntimeProviderHost;
}

const fakeContext = { id: 'ws-1', root: 'ssh://fakehost/tmp/x', metadata: undefined };

describe('SshRuntimeProviderFactory', () => {
  let fake: FakeSshEnv | undefined;

  beforeAll(() => {
    buildRtsBundle();
  }, 120_000);

  afterEach(async () => {
    await fake?.restore();
    fake = undefined;
  });

  it('ignores non-ssh roots without touching the flag or the network', async () => {
    const captured: { runtime?: Runtime } = {};
    const provider = new SshRuntimeProviderFactory();
    const attachment = await provider.attach(
      { id: 'ws-1', root: '/tmp/proj' } as never,
      fakeHost(false, captured),
    );
    expect(captured.runtime).toBeUndefined();
    await attachment.dispose();
  });

  it('rejects ssh roots while the ssh-workdir flag is off', async () => {
    const provider = new SshRuntimeProviderFactory();
    await expect(
      provider.attach(fakeContext as never, fakeHost(false, {})),
    ).rejects.toMatchObject({ code: ErrorCodes.WORKSPACE_SSH_DISABLED });
  });

  it('maps a connect failure to workspace.ssh_connect_failed', async () => {
    fake = await fakeSshEnv();
    process.env['FAKE_SSH_NO_NODE'] = '1';
    const provider = new SshRuntimeProviderFactory(fake.options);
    await expect(
      provider.attach(fakeContext as never, fakeHost(true, {})),
    ).rejects.toMatchObject({ code: ErrorCodes.WORKSPACE_SSH_CONNECT_FAILED });
  });

  itBash('registers a ready SshRuntime over the loopback pipe (fs + spawn round trip)', async () => {
    fake = await fakeSshEnv();
    const fakeHome = fake.fakeHome;
    const captured: { runtime?: Runtime } = {};
    const provider = new SshRuntimeProviderFactory(fake.options);
    const attachment = await provider.attach(fakeContext as never, fakeHost(true, captured));
    const ssh = captured.runtime as SshRuntime;
    expect(ssh).toBeInstanceOf(SshRuntime);
    expect(ssh.identity.runtimeId).toBe('local');
    expect(ssh.status).toBe('ready');
    expect([...ssh.capabilities].sort()).toEqual(['fs', 'process', 'watch']);
    expect(ssh.environment.pathClass).toBe('posix');
    expect(ssh.workspace.mapRoots({ workDir: 'ssh://fakehost/tmp/x' }).workDir).toBe('/tmp/x');
    expect(ssh.workspace.mapRoots({ workDir: '/plain/path' }).workDir).toBe('/plain/path');

    const dir = join(fakeHome, 'roundtrip');
    await ssh.fs.mkdir(dir, { recursive: true });
    const file = join(dir, 'a.txt');
    await ssh.fs.writeText(file, 'hello');
    await ssh.fs.appendText(file, ' world');
    expect(await ssh.fs.readText(file)).toBe('hello world');
    expect((await ssh.fs.stat(file)).isFile).toBe(true);
    expect((await ssh.fs.readdir(dir)).map((entry) => entry.name)).toEqual(['a.txt']);
    expect(await ssh.fs.realpath(dir)).toBe(dir);
    await ssh.fs.remove(file);
    await expect(ssh.fs.stat(file)).rejects.toThrow();

    const proc = await ssh.process.spawn(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.KIMI_PROBE ?? "")'],
      {
        cwd: fakeHome,
        env: { KIMI_PROBE: 'remote-env-ok' },
      },
    );
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    proc.stdout.resume();
    expect(await proc.wait()).toBe(0);
    expect(out).toBe('remote-env-ok');

    expect(ssh.connection.state()).toBe('ready');
    await expect(ssh.connection.resume()).resolves.toBeUndefined();
    await attachment.dispose();
  }, 60_000);
});

describe('LocalRuntimeProviderFactory ssh skip', () => {
  it('does not register a local runtime for ssh roots', async () => {
    const captured: { runtime?: Runtime } = {};
    const provider = new LocalRuntimeProviderFactory();
    const attachment = await provider.attach(fakeContext as never, {
      get: () => {
        throw new Error('host services must not be touched for ssh roots');
      },
      provide: () => {
        throw new Error('unexpected');
      },
      registerRuntime: (runtime: Runtime) => {
        captured.runtime = runtime;
        return { runtimeId: runtime.identity.runtimeId, update: () => Promise.resolve(), remove: () => Promise.resolve() };
      },
    } as unknown as RuntimeProviderHost);
    expect(captured.runtime).toBeUndefined();
    await attachment.dispose();
  });
});

describe('ssh roots through IWorkspaceService.createOrTouch', () => {
  let homeDir: string;
  let host: ScopedTestHost | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IWorkspacePersistence,
      FileWorkspacePersistence,
      ScopeActivation.OnDemand,
      'workspace',
    );
    registerScopedService(
      LifecycleScope.App,
      IWorkspaceService,
      WorkspaceService,
      ScopeActivation.OnDemand,
      'workspace',
    );
    homeDir = await mkdtemp(join(tmpdir(), 'v2-ssh-workspace-service-'));
  });

  afterEach(async () => {
    host?.dispose();
    host = undefined;
    await rm(homeDir, { recursive: true, force: true });
  });

  function noLocalFs(): IHostFileSystem {
    return {
      stat: () => Promise.reject(new Error('local stat must not be called for ssh roots')),
    } as unknown as IHostFileSystem;
  }

  function build(flagEnabled: boolean): IWorkspaceService {
    const fileStorage = new FileStorageService(homeDir);
    host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IHostFileSystem, noLocalFs()),
      stubPair(IEventService, {
        publish: () => {},
        subscribe: () => ({ dispose: () => {} }),
      } as unknown as IEventService),
      stubPair(IFlagService, {
        enabled: (flag: string) => flag === SSH_WORKDIR_FLAG_ID && flagEnabled,
      } as unknown as IFlagService),
    ]);
    return host.app.accessor.get(IWorkspaceService);
  }

  it('rejects ssh roots while the ssh-workdir flag is off, before any local probe', async () => {
    await expect(build(false).createOrTouch('ssh://dev.example.com/srv/app')).rejects.toMatchObject({
      code: ErrorCodes.WORKSPACE_SSH_DISABLED,
    });
  });

  it('canonicalizes the ssh spec before minting the workspace id, without a local stat', async () => {
    const ws = await build(true).createOrTouch('SSH://Dev.EXAMPLE.com:22/srv//app/');
    expect(ws.root).toBe('ssh://Dev.EXAMPLE.com/srv/app');
    expect(ws.name).toBe('app');
  });
});
