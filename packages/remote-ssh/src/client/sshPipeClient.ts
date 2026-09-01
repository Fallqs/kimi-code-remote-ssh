/**
 * The OpenSSH pipe lifecycle client: owns the local `ssh` child, the remote
 * RTS deploy, and the reconnect state machine.
 *
 * The pipe is `ssh -T -o BatchMode=yes ... [user@]host <pipeCommand>` with
 * the RTS stdio protocol multiplexed over it. The pipe command comes from
 * the deploy flavor resolved on every (re)connect: the prebuilt SEA binary
 * (`rts-bin`, remote needs nothing installed) when a local artifact matches
 * the remote platform, else the node script (`node rts.js`, remote needs
 * node >= 20). BatchMode makes every invocation fail-closed (no
 * host-key/password prompts ever hang the pipe); ssh stderr is captured and
 * surfaced verbatim in connection errors.
 *
 * State machine (`SshPipeState`): an unexpected pipe loss never silently
 * recovers — after a successful background reconnect the client sits in
 * `blocked` and every call fails fast with {@link RemoteBlockedError} until
 * the caller explicitly `resume()`s (OQ-R3: an interrupted command is never
 * silently glossed over).
 */

import { type ChildProcess, spawn } from 'node:child_process';

import { RtsClient, RtsError, type RtsClientCloseInfo } from '#/client/client';
import {
  REMOTE_BIN_PIPE_COMMAND,
  REMOTE_PIPE_COMMAND,
  deploy,
  deployBin,
  deployTimeoutForBytes,
  makeSshExec,
  probeRemote,
  probeRemoteBin,
  probeRemotePlatform,
  readLocalBundle,
  readLocalSeaBinary,
  type SshExec,
  type SshExecResult,
} from '#/client/deploy';
import { RtsFs } from '#/client/fs';
import type { RtsClientProcess } from '#/client/process';
import { resolveSshConnection } from '#/client/sshConfig';
import { RTS_VERSION, type RemoteFacts } from '#/protocol/frames';
import type { OpName, OpParams, OpResults, ProcSpawnParams } from '#/protocol/ops';
import {
  formatSshWorkDirSpec,
  parseSshWorkDirSpec,
  type SshWorkDirSpec,
} from '#/ssh-spec';

export type SshPipeState =
  /** Never connected, or pipe down while a reconnect backoff elapses. */
  | 'disconnected'
  /** The initial `connect()` probe/deploy/handshake is in flight. */
  | 'connecting'
  /** Connected; calls flow. */
  | 'ready'
  /** A background reconnect attempt (probe + redeploy-if-stale + pipe) is in flight. */
  | 'reconnecting'
  /** Reconnected after a loss; calls stay rejected until `resume()`. */
  | 'blocked'
  /** `close()` ran (or the initial connect failed); terminal. */
  | 'closed';

/** Fast-reject error for calls made while the pipe is not `ready`. */
export class RemoteBlockedError extends Error {
  readonly code = 'EBLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'RemoteBlockedError';
  }
}

export type SshPipeStateChangeListener = (state: SshPipeState, previous: SshPipeState) => void;

export interface SshPipeOptions {
  /** ssh binary (default 'ssh'); tests point it at a wrapper. */
  readonly sshPath?: string;
  /**
   * Extra args placed before the built-in options (OpenSSH options are
   * order-independent until repeated — the FIRST occurrence wins, so these
   * can override the built-ins). The fake-ssh test harness uses this slot
   * (with `sshPath = node`) to inject its script.
   */
  readonly sshArgs?: string[];
  /**
   * Local RTS bundle override (default: this package's dist/rts.js, falling
   * back to the build-time embedded source in packaged builds).
   */
  readonly bundlePath?: string;
  /**
   * Deploy flavor selection (default `'auto'`):
   * - `'auto'`: the prebuilt SEA binary when a local artifact exists for the
   *   remote's `uname -sm` platform, else the node-script flavor (which needs
   *   node >= 20 on the remote PATH).
   * - `'binary'`: require the binary artifact; connect fails with build
   *   instructions when it is missing.
   * - `'script'`: always the node-script flavor, even when an artifact exists.
   */
  readonly deployMode?: 'auto' | 'binary' | 'script';
  /**
   * Local SEA artifact directory override (holds `<platform>/rts-bin`;
   * default: this package's sea/). Tests use it.
   */
  readonly seaDir?: string;
  /** Bounds every one-shot ssh exec and the RTS handshake (default 15 s). */
  readonly connectTimeoutMs?: number;
  /** Reconnect backoff schedule; the last value caps further attempts. */
  readonly reconnectBackoffMs?: number[];
  /** OpenSSH client-config override (default `~/.ssh/config`). */
  readonly sshConfigPath?: string;
  readonly onStateChange?: SshPipeStateChangeListener;
  readonly onLog?: (message: string) => void;
}

export const DEFAULT_RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** Ring-buffer cap for the ssh/rts stderr captured for error messages. */
const SSH_STDERR_CAP = 64 * 1024;

export class SshPipeClient {
  /** Typed fs wrappers; each call is gated on the current state. */
  readonly fs: RtsFs;

  private readonly _spec: SshWorkDirSpec;
  private readonly _canonical: string;
  private readonly _sshPath: string;
  private readonly _sshArgs: string[];
  private readonly _bundlePath: string | undefined;
  private readonly _deployMode: 'auto' | 'binary' | 'script';
  private readonly _seaDir: string | undefined;
  private readonly _connectTimeoutMs: number;
  private readonly _backoffMs: number[];
  private readonly _log: (message: string) => void;
  private readonly _listeners = new Set<SshPipeStateChangeListener>();
  /** `[user@]host` destination passed to ssh; the host stays as typed (a `Host` alias is NOT resolved). */
  private readonly _dest: string;
  private readonly _port: number | undefined;
  private readonly _exec: SshExec;

  private _state: SshPipeState = 'disconnected';
  private _client: RtsClient | undefined;
  private _facts: RemoteFacts | undefined;
  private _sshChild: ChildProcess | undefined;
  private _sshStderr = '';
  private _sshSpawnError: Error | undefined;
  private _lastExecResult: SshExecResult | undefined;
  /** Pipe remote-command resolved by `_ensureDeployed` (deploy flavor). */
  private _pipeCommand = REMOTE_PIPE_COMMAND;
  private _closing = false;
  private _reconnectAttempt = 0;
  private _reconnectTimer: NodeJS.Timeout | undefined;

  private constructor(spec: SshWorkDirSpec | string, options?: SshPipeOptions) {
    this._spec = typeof spec === 'string' ? parseSshWorkDirSpec(spec) : spec;
    this._canonical = formatSshWorkDirSpec(this._spec);
    this._sshPath = options?.sshPath ?? 'ssh';
    this._sshArgs = options?.sshArgs ?? [];
    this._bundlePath = options?.bundlePath;
    this._deployMode = options?.deployMode ?? 'auto';
    this._seaDir = options?.seaDir;
    this._connectTimeoutMs = options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this._backoffMs =
      options?.reconnectBackoffMs !== undefined && options.reconnectBackoffMs.length > 0
        ? options.reconnectBackoffMs
        : DEFAULT_RECONNECT_BACKOFF_MS;
    this._log = options?.onLog ?? (() => {});
    if (options?.onStateChange !== undefined) {
      this._listeners.add(options.onStateChange);
    }

    // The destination keeps the host exactly as typed: when it is a `Host`
    // alias, the spawned ssh matches the stanza in ~/.ssh/config itself and
    // applies everything in it (HostName, IdentityFile, ProxyJump, ...).
    // Resolving the alias to its HostName here would bypass the stanza and
    // silently drop those settings. Config-resolved user/port are still
    // passed explicitly: they duplicate what the stanza would apply, and
    // OpenSSH command-line precedence makes spec-level values win.
    const config = resolveSshConnection(this._spec.host, {
      configPath: options?.sshConfigPath,
    });
    const user = this._spec.user ?? config.user;
    this._port = this._spec.port ?? config.port;
    this._dest = user === undefined ? this._spec.host : `${user}@${this._spec.host}`;

    this._exec = makeSshExec(this._sshPath, this._sshBaseArgv(), {
      onResult: result => {
        this._lastExecResult = result;
      },
    });
    this.fs = new RtsFs((op, params) => this._requireReady().call(op, params));
  }

  /**
   * Probe, deploy the bundle when missing/stale, open the pipe, and shake
   * hands. First-connect failures (node missing, host key, auth) reject
   * with the ssh stderr attached.
   */
  static async connect(
    spec: SshWorkDirSpec | string,
    options?: SshPipeOptions,
  ): Promise<SshPipeClient> {
    const client = new SshPipeClient(spec, options);
    await client._openInitial();
    return client;
  }

  get state(): SshPipeState {
    return this._state;
  }

  /** Canonical `ssh://...` identity string of the workdir spec. */
  get spec(): string {
    return this._canonical;
  }

  /** Remote host facts; throws until the pipe has connected at least once. */
  get facts(): RemoteFacts {
    if (this._facts === undefined) {
      throw new Error('ssh pipe has not connected yet; facts are unavailable');
    }
    return this._facts;
  }

  async call<O extends OpName>(op: O, params: OpParams[O]): Promise<OpResults[O]>;
  async call<T = unknown>(op: string, params: Record<string, unknown>): Promise<T>;
  async call(op: string, params: object): Promise<unknown> {
    return this._requireReady().call(op, params as Record<string, unknown>);
  }

  /** Spawn a remote process over the pipe; gated like {@link call}. */
  async spawn(params: ProcSpawnParams): Promise<RtsClientProcess> {
    return this._requireReady().spawn(params);
  }

  /**
   * Acknowledge an interrupted connection: valid only from `blocked` (after
   * a successful background reconnect), flips the client back to `ready`.
   */
  async resume(): Promise<void> {
    if (this._state !== 'blocked') {
      throw new Error(`resume() is only valid in the blocked state (current: ${this._state})`);
    }
    this._setState('ready');
  }

  onStateChange(listener: SshPipeStateChangeListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /** Idempotent: stops reconnecting, ends the pipe, kills the ssh child. */
  async close(): Promise<void> {
    if (this._state === 'closed') return;
    this._closing = true;
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
    this._setState('closed');
    const client = this._client;
    this._client = undefined;
    if (client !== undefined) {
      await client.close();
    }
    this._killSshChild();
  }

  // ── connection lifecycle ─────────────────────────────────────────────

  private async _openInitial(): Promise<void> {
    this._setState('connecting');
    try {
      await this._ensureDeployed();
      this._client = await this._openPipe();
      this._facts = this._client.facts;
      this._setState('ready');
    } catch (error) {
      // No instance escapes connect(); tear down so nothing reconnects.
      this._closing = true;
      this._killSshChild();
      this._setState('closed');
      throw error;
    }
  }

  /**
   * Pick the deploy flavor and (re)deploy when the remote side is missing or
   * stale. The `uname -sm` probe is the first exec of every connect, so an
   * unreachable remote (ssh exit 255) surfaces here regardless of flavor.
   */
  private async _ensureDeployed(): Promise<void> {
    const platform = await probeRemotePlatform(this._exec, { timeoutMs: this._connectTimeoutMs });
    if (platform === null && this._lastExecResult?.code === 255) {
      throw new Error(`ssh connection to ${this._dest} failed${this._probeDetail()}`);
    }
    // An unrecognized platform (null) can have no prebuilt artifact: the
    // script flavor takes over exactly as if no artifact existed.
    const binary =
      this._deployMode === 'script' || platform === null
        ? null
        : await readLocalSeaBinary(platform, this._seaDir);
    if (binary !== null) {
      this._pipeCommand = REMOTE_BIN_PIPE_COMMAND;
      await this._ensureBinDeployed(binary);
      return;
    }
    if (this._deployMode === 'binary') {
      throw new Error(
        `deployMode 'binary' requires a prebuilt RTS binary for ${platform ?? 'the remote platform'}, ` +
          'but none was found. Run `pnpm --filter @moonshot-ai/remote-ssh build:sea` first ' +
          '(or point the seaDir option at one).',
      );
    }
    this._pipeCommand = REMOTE_PIPE_COMMAND;
    await this._ensureScriptDeployed();
  }

  /** Probe the deployed binary and (re)deploy it when missing or stale. */
  private async _ensureBinDeployed(binary: Buffer): Promise<void> {
    const version = await probeRemoteBin(this._exec, { timeoutMs: this._connectTimeoutMs });
    if (version !== RTS_VERSION) {
      this._log(`deploying RTS binary ${RTS_VERSION} (remote: ${version ?? 'none'})`);
      await deployBin(this._exec, binary, {
        timeoutMs: deployTimeoutForBytes(binary.length, this._connectTimeoutMs),
      });
    }
  }

  /** Probe the remote and (re)deploy the bundle when missing or stale. */
  private async _ensureScriptDeployed(): Promise<void> {
    const probe = await probeRemote(this._exec, { timeoutMs: this._connectTimeoutMs });
    if (probe.nodeVersion === null) {
      if (this._lastExecResult?.code === 255) {
        throw new Error(`ssh connection to ${this._dest} failed${this._probeDetail()}`);
      }
      throw new Error(
        `remote node >= 20 is required on ${this._dest}, but \`node --version\` failed${this._probeDetail()}`,
      );
    }
    if (probe.rtsVersion !== RTS_VERSION) {
      this._log(`deploying RTS ${RTS_VERSION} (remote: ${probe.rtsVersion ?? 'none'})`);
      const bundle = await readLocalBundle(this._bundlePath);
      await deploy(this._exec, bundle, { timeoutMs: this._connectTimeoutMs });
    }
  }

  /** stderr (or stdout, when stderr is empty) of the last probe exec. */
  private _probeDetail(): string {
    const result = this._lastExecResult;
    if (result === undefined) return '';
    const detail = result.stderr.trim() || result.stdout.trim();
    return detail === '' ? '' : `: ${detail}`;
  }

  /** Spawn the ssh pipe child and handshake the RTS protocol over it. */
  private async _openPipe(): Promise<RtsClient> {
    const argv = this._sshPipeArgv();
    this._log(`opening pipe: ${this._sshPath} ${argv.join(' ')}`);
    const child = spawn(this._sshPath, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._sshChild = child;
    this._sshStderr = '';
    this._sshSpawnError = undefined;
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) {
      throw new Error('ssh child stdio pipes are unavailable');
    }
    stderr.on('data', (chunk: Buffer) => {
      this._sshStderr = (this._sshStderr + chunk.toString('utf8')).slice(-SSH_STDERR_CAP);
    });
    child.on('error', (error: Error) => {
      // Spawn failure (sshPath missing): break the pipes so the handshake
      // fails at once instead of waiting out the timeout.
      this._sshSpawnError = error;
      stdout.destroy();
      stdin.destroy();
    });
    try {
      return await RtsClient.connect(
        { readable: stdout, writable: stdin },
        {
          timeoutMs: this._connectTimeoutMs,
          onClose: info => {
            this._onPipeClosed(info);
          },
        },
      );
    } catch (error) {
      // The cast defeats control-flow narrowing: the 'error' listener above
      // may have assigned the spawn error between connect() and this catch.
      const spawnError = this._sshSpawnError as Error | undefined;
      const spawnDetail = spawnError === undefined ? '' : `${spawnError.message}; `;
      const stderrDetail = this._sshStderr.trim();
      throw new Error(
        `ssh pipe to ${this._dest} failed: ${spawnDetail}${(error as Error).message}` +
          (stderrDetail === '' ? '' : `\nssh stderr:\n${stderrDetail}`),
        { cause: error },
      );
    }
  }

  private _onPipeClosed(info: RtsClientCloseInfo): void {
    if (this._closing) return;
    // Only an established pipe dropping is a "loss": during connecting /
    // reconnecting the in-flight attempt settles itself through its await.
    if (this._state !== 'ready' && this._state !== 'blocked') return;
    this._log(`pipe lost (${info.reason}${info.error === undefined ? '' : `: ${info.error}`})`);
    this._reconnectAttempt = 0;
    this._setState('disconnected');
    this._scheduleReconnect();
  }

  private _scheduleReconnect(): void {
    if (this._closing) return;
    const delay = this._backoffMs[Math.min(this._reconnectAttempt, this._backoffMs.length - 1)]!;
    this._reconnectAttempt += 1;
    this._log(`reconnect attempt ${String(this._reconnectAttempt)} in ${String(delay)} ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = undefined;
      void this._reconnectOnce();
    }, delay);
  }

  /** One probe + redeploy-if-stale + pipe attempt; success lands in `blocked`. */
  private async _reconnectOnce(): Promise<void> {
    if (this._closing) return;
    this._setState('reconnecting');
    try {
      await this._ensureDeployed();
      const client = await this._openPipe();
      if (this._closing) {
        await client.close();
        this._killSshChild();
        return;
      }
      this._client = client;
      this._facts = client.facts;
      this._setState('blocked');
    } catch (error) {
      this._log(`reconnect failed: ${(error as Error).message}`);
      if (!this._closing) {
        this._setState('disconnected');
        this._scheduleReconnect();
      }
    }
  }

  // ── argv builders ────────────────────────────────────────────────────

  /**
   * Connection args shared by every ssh invocation. `sshArgs` lead (see the
   * option docs); the pipe form adds `-T` (no pty) and keepalives, the
   * one-shot exec form is this list alone.
   */
  private _sshBaseArgv(): string[] {
    const args = [...this._sshArgs, '-o', 'BatchMode=yes'];
    if (this._port !== undefined) {
      args.push('-p', String(this._port));
    }
    args.push(this._dest);
    return args;
  }

  private _sshPipeArgv(): string[] {
    return [
      ...this._sshArgs,
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      ...(this._port === undefined ? [] : ['-p', String(this._port)]),
      this._dest,
      this._pipeCommand,
    ];
  }

  // ── state helpers ────────────────────────────────────────────────────

  /** Gate every remote op on `ready`; anything else fails fast. */
  private _requireReady(): RtsClient {
    if (this._state === 'ready' && this._client !== undefined) {
      return this._client;
    }
    if (this._state === 'closed') {
      throw new RtsError('ECLOSED', 'ssh pipe client is closed');
    }
    if (this._state === 'blocked') {
      throw new RemoteBlockedError(
        'connection interrupted and re-established; call resume() to continue',
      );
    }
    throw new RemoteBlockedError('connection interrupted; reconnect in progress');
  }

  private _setState(state: SshPipeState): void {
    if (this._state === state) return;
    const previous = this._state;
    this._state = state;
    this._log(`state: ${previous} -> ${state}`);
    for (const listener of this._listeners) {
      listener(state, previous);
    }
  }

  private _killSshChild(): void {
    const child = this._sshChild;
    this._sshChild = undefined;
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
}
