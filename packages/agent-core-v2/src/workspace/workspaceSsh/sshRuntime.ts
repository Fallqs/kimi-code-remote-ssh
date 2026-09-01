import * as posixPath from 'node:path/posix';

import {
  isSshWorkDirSpec,
  parseSshWorkDirSpec,
  type RtsClientProcess,
  type RtsDirEntry,
  type RtsStat,
  type SshPipeClient,
  type SshPipeState,
} from '@moonshot-ai/remote-ssh';

import { Emitter } from '#/_base/event';
import { BufferedReadable } from '#/_base/execEnv/bufferedReadable';
import type { TextDecodeErrors } from '#/_base/execEnv/decodeText';
import type { OsKind } from '#/_base/execEnv/environmentProbe';
import type {
  HostDirEntry,
  HostFileStat,
  IHostFileSystem,
} from '#/os/interface/hostFileSystem';
import type { HostFsChange, IHostFsWatchHandle, IHostFsWatchService, HostFsWatchOptions } from '#/os/interface/hostFsWatch';
import type {
  HostProcessOptions,
  IHostProcess,
  IHostProcessService,
} from '#/os/interface/hostProcess';
import type {
  Runtime,
  RuntimeCapability,
  RuntimePath,
  RuntimeStatus,
  RuntimeWorkspaceRoots,
} from '#/runtime/runtime';

import { WorkspaceSshConnectionService } from './sshConnection';

let nextGeneration = 1;

function toOsKind(platform: string): OsKind {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    default:
      return platform;
  }
}

function toRuntimeStatus(state: SshPipeState): RuntimeStatus {
  switch (state) {
    case 'ready':
      return 'ready';
    case 'connecting':
    case 'reconnecting':
      return 'connecting';
    case 'blocked':
      return 'degraded';
    default:
      return 'disconnected';
  }
}

function toHostFileStat(st: RtsStat): HostFileStat {
  return {
    isFile: st.isFile,
    isDirectory: st.isDirectory,
    isSymbolicLink: st.isSymlink,
    size: st.stSize,
    mtimeMs: st.stMtime,
    ino: st.stIno,
  };
}

function toHostDirEntry(entry: RtsDirEntry): HostDirEntry {
  return {
    name: entry.name,
    isFile: entry.isFile,
    isDirectory: entry.isDirectory,
    isSymbolicLink: entry.isSymlink,
  };
}

function errorCode(error: unknown): string | undefined {
  return (error as { readonly code?: unknown } | undefined)?.code as string | undefined;
}

class SshHostProcess implements IHostProcess {
  declare readonly _serviceBrand: undefined;

  readonly stdin: IHostProcess['stdin'];
  readonly stdout: IHostProcess['stdout'];
  readonly stderr: IHostProcess['stderr'];
  readonly pid: number;

  private readonly proc: RtsClientProcess;
  private currentExitCode: number | null = null;
  private readonly exitPromise: Promise<number>;

  constructor(proc: RtsClientProcess) {
    this.proc = proc;
    this.stdin = proc.stdin;
    this.stdout = new BufferedReadable(proc.stdout);
    this.stderr = new BufferedReadable(proc.stderr);
    this.pid = proc.pid;
    this.exitPromise = proc.wait().then((code) => {
      this.currentExitCode = code ?? -1;
      return this.currentExitCode;
    });
  }

  get exitCode(): number | null {
    return this.currentExitCode;
  }

  wait(): Promise<number> {
    return this.exitPromise;
  }

  kill(signal?: NodeJS.Signals): Promise<void> {
    this.proc.kill(signal);
    return Promise.resolve();
  }

  dispose(): void {
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
  }
}

class SshHostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly runtime: SshRuntime) {}

  private get client(): SshPipeClient {
    return this.runtime.client;
  }

  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string> {
    void options?.errors;
    return this.client.fs.readText(path, { encoding: options?.encoding });
  }

  writeText(path: string, data: string): Promise<void> {
    return this.client.fs.writeText(path, data);
  }

  appendText(path: string, data: string): Promise<void> {
    return this.client.fs.writeText(path, data, { append: true });
  }

  async readBytes(path: string, n?: number, offset?: number): Promise<Uint8Array> {
    const data = await this.client.fs.readBytes(path, {
      maxBytes: n === undefined ? undefined : n + (offset ?? 0),
    });
    return offset === undefined || offset === 0 ? data : data.subarray(offset);
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    const proc = await this.runtime.process.spawn('bash', ['-c', 'cat > "$1"', 'bash', path], {
      cwd: this.runtime.environment.homeDir,
    });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.stdout.resume();
    try {
      proc.stdin.write(data);
      proc.stdin.end();
    } catch {
    }
    const exitCode = await proc.wait();
    try {
      proc.dispose();
    } catch {
    }
    if (exitCode !== 0) {
      const detail = stderr.trim();
      throw new Error(
        `writeBytes failed for ${path} (exit ${String(exitCode)})${detail === '' ? '' : `: ${detail}`}`,
      );
    }
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string> {
    void options;
    for (const line of await this.client.fs.readLines(path)) {
      yield line;
    }
  }

  async createExclusive(path: string, data: Uint8Array): Promise<boolean> {
    const proc = await this.runtime.process.spawn(
      'bash',
      ['-c', 'set -o noclobber && cat > "$1"', 'bash', path],
      { cwd: this.runtime.environment.homeDir },
    );
    try {
      proc.stdin.write(data);
      proc.stdin.end();
    } catch {
    }
    proc.stdout.resume();
    proc.stderr.resume();
    const exitCode = await proc.wait();
    try {
      proc.dispose();
    } catch {
    }
    if (exitCode === 0) return true;
    if (await this.client.fs.exists(path)) return false;
    throw new Error(`createExclusive failed for ${path} (exit ${String(exitCode)})`);
  }

  async stat(path: string): Promise<HostFileStat> {
    return toHostFileStat(await this.client.fs.stat(path, { followSymlinks: true }));
  }

  async lstat(path: string): Promise<HostFileStat> {
    return toHostFileStat(await this.client.fs.stat(path, { followSymlinks: false }));
  }

  async readdir(path: string): Promise<readonly HostDirEntry[]> {
    return (await this.client.fs.readdir(path)).map(toHostDirEntry);
  }

  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    return this.client.fs.mkdir(path, { recursive: options?.recursive });
  }

  async remove(path: string): Promise<void> {
    try {
      await this.client.fs.remove(path, { recursive: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
  }

  realpath(path: string): Promise<string> {
    return this.client.fs.realpath(path);
  }
}

class SshHostProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly runtime: SshRuntime) {}

  async spawn(
    command: string,
    args: readonly string[] = [],
    options?: HostProcessOptions,
  ): Promise<IHostProcess> {
    const proc = await this.runtime.client.spawn({
      cmd: command,
      args: [...args],
      cwd: options?.cwd ?? this.runtime.remoteRoot,
      env: options?.env,
    });
    return new SshHostProcess(proc);
  }
}

class SshFsWatchHandle implements IHostFsWatchHandle {
  readonly ready = Promise.resolve();
  private readonly emitter = new Emitter<HostFsChange>();
  readonly onDidChange = this.emitter.event;

  dispose(): void {
    this.emitter.dispose();
  }
}

class SshFsWatchService implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle {
    void path;
    void options;
    return new SshFsWatchHandle();
  }
}

export class SshRuntime implements Runtime {
  readonly identity;
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly environment;
  readonly path: RuntimePath;
  readonly workspace: Runtime['workspace'];
  readonly fs: IHostFileSystem;
  readonly process: IHostProcessService;
  readonly watch: IHostFsWatchService;
  readonly terminal = undefined;
  readonly connection: WorkspaceSshConnectionService;
  readonly remoteRoot: string;
  private currentStatus: RuntimeStatus;
  private readonly statusEmitter = new Emitter<RuntimeStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private readonly stateSubscription: () => void;

  constructor(
    workspaceId: string,
    readonly client: SshPipeClient,
  ) {
    this.identity = { workspaceId, runtimeId: 'local', generation: `ssh-${nextGeneration++}` };
    this.capabilities = new Set<RuntimeCapability>(['fs', 'process', 'watch']);
    const facts = client.facts;
    this.environment = {
      osKind: toOsKind(facts.osKind),
      osArch: facts.osArch,
      osVersion: facts.osVersion,
      shellName: facts.shellName,
      shellPath: facts.shellPath,
      pathClass: facts.pathClass,
      homeDir: facts.homeDir,
    };
    const path = posixPath;
    this.path = {
      separator: path.sep as '/' | '\\',
      delimiter: path.delimiter as ':' | ';',
      isAbsolute: (p) => path.isAbsolute(p),
      join: (...paths) => path.join(...paths),
      relative: (from, to) => path.relative(from, to),
      resolve: (...paths) => path.resolve(...paths),
      basename: (p) => path.basename(p),
      dirname: (p) => path.dirname(p),
    };
    this.remoteRoot = parseSshWorkDirSpec(client.spec).path;
    this.workspace = {
      mapRoots: (roots: RuntimeWorkspaceRoots): RuntimeWorkspaceRoots => ({
        workDir: this.mapRoot(roots.workDir),
        additionalDirs: roots.additionalDirs?.map((root) => this.mapRoot(root)),
      }),
    };
    this.fs = new SshHostFileSystem(this);
    this.process = new SshHostProcessService(this);
    this.watch = new SshFsWatchService();
    this.connection = new WorkspaceSshConnectionService(client);
    this.currentStatus = toRuntimeStatus(client.state);
    this.stateSubscription = client.onStateChange((state) => {
      const next = toRuntimeStatus(state);
      if (next === this.currentStatus) return;
      this.currentStatus = next;
      this.statusEmitter.fire(next);
    });
  }

  get status(): RuntimeStatus {
    return this.currentStatus;
  }

  private mapRoot(root: string): string {
    return isSshWorkDirSpec(root) ? parseSshWorkDirSpec(root).path : root;
  }

  async dispose(): Promise<void> {
    this.stateSubscription();
    this.currentStatus = 'disposed';
    this.statusEmitter.fire('disposed');
    this.statusEmitter.dispose();
    await this.client.close();
  }
}
