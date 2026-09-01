import { Readable, Writable } from 'node:stream';

import type { RtsClient } from '#/client/client';

/**
 * A process running on the remote, spawned via `proc.spawn`. stdio is
 * exposed as node streams; exit arrives as a frame over the shared
 * transport.
 */
export class RtsClientProcess {
  /** Channel id on the RTS connection. */
  readonly channel: number;
  /** Remote pid; the process runs in its own process group (`-pid`). */
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  /** Set when the exit frame arrives; both stay null if the transport drops first. */
  exitCode: number | null = null;
  exitSignal: string | null = null;

  private readonly _client: RtsClient;
  private _exited = false;
  private readonly _waitPromise: Promise<number | null>;
  private _waitResolve!: (code: number | null) => void;

  /** @internal */
  constructor(client: RtsClient, channel: number, pid: number) {
    this._client = client;
    this.channel = channel;
    this.pid = pid;
    this._waitPromise = new Promise(resolve => {
      this._waitResolve = resolve;
    });
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        client._procStdin(channel, chunk, callback);
      },
      final: callback => {
        client._procStdinEof(channel);
        callback();
      },
    });
  }

  /** Exit code; null when the process was signaled or the transport dropped. */
  wait(): Promise<number | null> {
    return this._waitPromise;
  }

  /** Signal the remote process GROUP (default SIGTERM). Fire-and-forget. */
  kill(signal?: string): void {
    this._client._procKill(this.channel, signal);
  }

  /** @internal */
  _onData(stream: 'stdout' | 'stderr', data: Buffer): void {
    (stream === 'stdout' ? this.stdout : this.stderr).push(data);
  }

  /** @internal */
  _onExit(code: number | null, signal: string | null): void {
    this._finish(code, signal);
  }

  /** @internal */
  _onTransportClosed(): void {
    // Orderly end for stream consumers; the exit code is unknowable.
    this._finish(null, null);
  }

  private _finish(code: number | null, signal: string | null): void {
    if (this._exited) return;
    this._exited = true;
    this.exitCode = code;
    this.exitSignal = signal;
    this.stdout.push(null);
    this.stderr.push(null);
    if (!this.stdin.destroyed) this.stdin.destroy();
    this._waitResolve(code);
  }
}
