import { type ChildProcess, spawn } from 'node:child_process';

import type { ServerFrame } from '#/protocol/frames';
import type { ProcSpawnResult } from '#/protocol/ops';
import {
  optionalAbsolutePath,
  optionalEnv,
  requireString,
  requireStringArray,
} from '#/server/validate';

export type ProcSend = (frame: ServerFrame) => Promise<void>;

/**
 * Multiplexes concurrent child processes over the frame stream. Each spawn
 * gets a channel id; stdout/stderr/exit travel back as frames, stdin/kill
 * arrive as frames. Every child runs detached in its own process group, so
 * kill targets the whole group (`process.kill(-pid, signal)`) and a dropped
 * connection can reap entire trees via `killAll`.
 */
export class ProcMux {
  private _nextChannel = 1;
  private readonly _procs = new Map<number, ChildProcess>();

  constructor(
    private readonly _send: ProcSend,
    private readonly _baseCwd: string,
    private readonly _log: (message: string) => void,
  ) {}

  get liveCount(): number {
    return this._procs.size;
  }

  async spawn(params: Record<string, unknown>): Promise<ProcSpawnResult> {
    const cmd = requireString(params, 'cmd');
    const args = requireStringArray(params, 'args');
    const cwd = optionalAbsolutePath(params, 'cwd') ?? this._baseCwd;
    const env = optionalEnv(params, 'env');

    // Structured argv, no shell; `detached` puts the child in its own
    // process group so kill signals the whole tree.
    const child = spawn(cmd, args, {
      cwd,
      env: env === undefined ? process.env : { ...process.env, ...env },
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // A spawn failure (ENOENT, bad cwd) surfaces as an 'error' event before
    // 'spawn'; either settles the call.
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        resolve();
      });
      child.once('error', (error: Error) => {
        reject(error);
      });
    });
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error('spawn succeeded but the child pid is unavailable');
    }

    const channel = this._nextChannel++;
    this._procs.set(channel, child);

    const stdout = child.stdout;
    const stderr = child.stderr;
    // Pause the pipe until the frame has been accepted by the transport
    // (drain awaited), so a slow client back-pressures the remote process's
    // kernel pipe instead of growing the server's memory.
    stdout.on('data', (data: Buffer) => {
      stdout.pause();
      void this._send({ type: 'proc.data', channel, stream: 'stdout', data: data.toString('base64') }).then(
        () => stdout.resume(),
        () => stdout.resume(),
      );
    });
    stderr.on('data', (data: Buffer) => {
      stderr.pause();
      void this._send({ type: 'proc.data', channel, stream: 'stderr', data: data.toString('base64') }).then(
        () => stderr.resume(),
        () => stderr.resume(),
      );
    });
    // Writing to a dead child's stdin raises EPIPE asynchronously; it is not
    // an error of the server itself.
    child.stdin.on('error', () => {});
    child.on('exit', (code, signal) => {
      this._procs.delete(channel);
      void this._send({ type: 'proc.exit', channel, code, signal }).catch(() => {});
    });

    return { channel, pid };
  }

  stdin(channel: number, data: string): void {
    const child = this._procs.get(channel);
    const stdin = child?.stdin;
    if (stdin === undefined || stdin === null || stdin.destroyed) return;
    stdin.write(Buffer.from(data, 'base64'));
  }

  stdinEof(channel: number): void {
    const child = this._procs.get(channel);
    if (child?.stdin?.destroyed === false) {
      child.stdin.end();
    }
  }

  /** Signal the whole process group; ESRCH (already gone) counts as success. */
  kill(channel: number, signal?: string): void {
    const child = this._procs.get(channel);
    if (child === undefined) {
      this._log(`proc.kill for unknown channel ${String(channel)}`);
      return;
    }
    this._killGroup(child, signal ?? 'SIGTERM');
  }

  killAll(signal: NodeJS.Signals = 'SIGKILL'): void {
    for (const child of this._procs.values()) {
      this._killGroup(child, signal);
    }
  }

  private _killGroup(child: ChildProcess, signal: string): void {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal as NodeJS.Signals);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      // Windows dev machines cannot signal process groups; fall back to the
      // direct child. Grandchildren may survive there — POSIX remotes are
      // the real target.
      try {
        child.kill(signal as NodeJS.Signals);
      } catch (fallbackError) {
        this._log(`kill(${String(pid)}, ${signal}) failed: ${String(fallbackError)}`);
      }
    }
  }
}
