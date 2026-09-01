import { Duplex, type Readable, type Writable } from 'node:stream';

import { FrameDecoder, FrameWriter } from '#/protocol/codec';
import {
  RTS_PROTOCOL,
  type ClientFrame,
  type ProcDataFrame,
  type ProcExitFrame,
  type RemoteFacts,
  type ServerFrame,
} from '#/protocol/frames';
import type { OpName, OpParams, OpResults, ProcSpawnParams, ProcSpawnResult } from '#/protocol/ops';
import { RtsFs } from '#/client/fs';
import { RtsClientProcess } from '#/client/process';

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** Error reply from the server (`err` frame) or a client-side protocol/transport failure. */
export class RtsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RtsError';
    this.code = code;
  }
}

/** An established duplex (e.g. an ssh stdio pipe) or a separate readable/writable pair. */
export type RtsTransport = Duplex | { readable: Readable; writable: Writable };

export interface RtsClientOptions {
  /**
   * Per-call timeout in ms (no default); also bounds the handshake
   * (default 10 s there).
   */
  timeoutMs?: number;
  /** Fires exactly once when the transport closes, for any reason. */
  onClose?: (info: RtsClientCloseInfo) => void;
}

export interface RtsClientCloseInfo {
  /** 'closed' = local close(), 'eof' = peer ended the stream, 'error' = broken transport/protocol. */
  reason: 'closed' | 'eof' | 'error';
  error?: string;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

type ProcFrame = ProcDataFrame | ProcExitFrame;

/** Cap on frames buffered for channels the client has not registered yet. */
const PROC_BACKLOG_CAP = 1024;

/**
 * Transport-agnostic RTS client. `connect` takes an ALREADY established
 * stream (B1b owns the ssh process lifecycle), validates the hello
 * handshake, and multiplexes calls and process channels over it.
 */
export class RtsClient {
  readonly fs: RtsFs;

  private readonly _options: RtsClientOptions;
  private readonly _writer: FrameWriter;
  private readonly _decoder: FrameDecoder;
  private readonly _writable: Writable;
  private _state: 'handshaking' | 'open' | 'closed' = 'handshaking';
  private _facts: RemoteFacts | undefined;
  private _version: string | undefined;
  private _nextId = 1;
  private readonly _pending = new Map<number, PendingCall>();
  private readonly _procs = new Map<number, RtsClientProcess>();
  // Frames for a channel can arrive in the same decode batch as the spawn
  // reply, before spawn()'s continuation registers the process; they are
  // buffered here and drained at registration.
  private readonly _procBacklog = new Map<number, ProcFrame[]>();
  private readonly _helloPromise: Promise<void>;
  private _settleHello!: (error?: Error) => void;

  private constructor(transport: RtsTransport, options?: RtsClientOptions) {
    this._options = options ?? {};
    const { readable, writable } =
      transport instanceof Duplex
        ? { readable: transport, writable: transport }
        : { readable: transport.readable, writable: transport.writable };
    this._writable = writable;
    this._writer = new FrameWriter(writable);
    this.fs = new RtsFs((op, params) => this._callRaw(op, params));
    this._helloPromise = new Promise((resolve, reject) => {
      this._settleHello = (error?: Error) => {
        if (error !== undefined) reject(error);
        else resolve();
      };
    });
    // Avoid an unhandled rejection when connect()'s own race also observes
    // the failure; connect re-throws via the race.
    this._helloPromise.catch(() => {});

    this._decoder = new FrameDecoder();
    readable.pipe(this._decoder);
    this._decoder.on('data', frame => {
      // The client only ever receives server frames; the decoder types
      // both directions, and the default case ignores protocol violations.
      this._onFrame(frame as ServerFrame);
    });
    this._decoder.on('error', error => {
      this._onTransportClosed('error', error);
    });
    readable.on('end', () => {
      this._onTransportClosed('eof');
    });
    readable.on('error', error => {
      this._onTransportClosed('error', error);
    });
    readable.on('close', () => {
      this._onTransportClosed('eof');
    });
    writable.on('error', error => {
      this._onTransportClosed('error', error);
    });
    writable.on('close', () => {
      this._onTransportClosed('eof');
    });
  }

  /** Establish the handshake; rejects when the hello is invalid or times out. */
  static async connect(transport: RtsTransport, options?: RtsClientOptions): Promise<RtsClient> {
    const client = new RtsClient(transport, options);
    await client._awaitHandshake();
    return client;
  }

  /** Remote host facts from the hello frame. */
  get facts(): RemoteFacts {
    if (this._facts === undefined) {
      throw new RtsError('EPROTOCOL', 'handshake has not completed');
    }
    return this._facts;
  }

  /** RTS version string reported by the server (for deploy staleness checks). */
  get version(): string {
    if (this._version === undefined) {
      throw new RtsError('EPROTOCOL', 'handshake has not completed');
    }
    return this._version;
  }

  get closed(): boolean {
    return this._state === 'closed';
  }

  async call<O extends OpName>(op: O, params: OpParams[O]): Promise<OpResults[O]>;
  async call<T = unknown>(op: string, params: Record<string, unknown>): Promise<T>;
  async call(op: string, params: object): Promise<unknown> {
    return this._callRaw(op, params);
  }

  /** Spawn a remote process (structured argv, no shell, own process group). */
  async spawn(params: ProcSpawnParams): Promise<RtsClientProcess> {
    const result = (await this._callRaw('proc.spawn', params)) as ProcSpawnResult;
    const proc = new RtsClientProcess(this, result.channel, result.pid);
    this._procs.set(result.channel, proc);
    const backlog = this._procBacklog.get(result.channel);
    if (backlog !== undefined) {
      this._procBacklog.delete(result.channel);
      for (const frame of backlog) {
        this._deliverProcFrame(frame);
      }
    }
    return proc;
  }

  /**
   * End the transport: pending calls reject with ECLOSED, process streams
   * end, and the server (seeing stdin EOF) kills its process groups.
   */
  async close(): Promise<void> {
    if (this._state === 'closed') return;
    this._onTransportClosed('closed');
    try {
      await this._writer.end();
    } catch {
      // Already broken; close() is best-effort.
    }
  }

  private async _callRaw(op: string, params: object): Promise<unknown> {
    if (this._state !== 'open') {
      throw new RtsError('ECLOSED', 'client is not connected');
    }
    const id = this._nextId++;
    const timeoutMs = this._options.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this._pending.delete(id);
              reject(new RtsError('ETIMEDOUT', `call "${op}" timed out after ${String(timeoutMs)} ms`));
            }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._send({ type: 'call', id, op, params: params as Record<string, unknown> }).catch(
        (error: Error) => {
          // A local send failure (e.g. oversized frame) settles just this
          // call; transport failures also tear down via the close path.
          if (this._pending.delete(id)) {
            if (timer !== undefined) clearTimeout(timer);
            reject(error);
          }
        },
      );
    });
  }

  private _awaitHandshake(): Promise<void> {
    const timeoutMs = this._options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new RtsError('ETIMEDOUT', `handshake timed out after ${String(timeoutMs)} ms`));
      }, timeoutMs);
    });
    return Promise.race([this._helloPromise, timeout]).catch((error: Error) => {
      this._onTransportClosed('error', error);
      throw error;
    }).finally(() => {
      clearTimeout(timer);
    });
  }

  private async _send(frame: ClientFrame): Promise<void> {
    await this._writer.write(frame);
  }

  private _onFrame(frame: ServerFrame): void {
    if (this._state === 'handshaking') {
      this._onHandshakeFrame(frame);
      return;
    }
    switch (frame.type) {
      case 'ok': {
        const pending = this._pending.get(frame.id);
        if (pending !== undefined) {
          this._pending.delete(frame.id);
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          pending.resolve(frame.result);
        }
        break;
      }
      case 'err': {
        const pending = this._pending.get(frame.id);
        if (pending !== undefined) {
          this._pending.delete(frame.id);
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          pending.reject(new RtsError(frame.code, frame.message));
        }
        break;
      }
      case 'proc.data':
      case 'proc.exit':
        this._deliverProcFrame(frame);
        break;
      case 'hello':
        this._onTransportClosed(
          'error',
          new RtsError('EPROTOCOL', 'duplicate hello frame'),
        );
        break;
      default:
        // Unknown frames are ignored for forward compatibility.
        break;
    }
  }

  private _onHandshakeFrame(frame: ServerFrame): void {
    if (frame.type !== 'hello') {
      this._settleHello(new RtsError('EPROTOCOL', `expected hello frame, got ${frame.type}`));
      return;
    }
    if (frame.protocol !== RTS_PROTOCOL) {
      this._settleHello(
        new RtsError(
          'EPROTOCOL',
          `unsupported RTS protocol ${String(frame.protocol)} (client speaks ${String(RTS_PROTOCOL)})`,
        ),
      );
      return;
    }
    this._facts = frame.facts;
    this._version = frame.version;
    this._state = 'open';
    this._settleHello();
  }

  private _deliverProcFrame(frame: ProcFrame): void {
    const proc = this._procs.get(frame.channel);
    if (proc === undefined) {
      const backlog = this._procBacklog.get(frame.channel) ?? [];
      if (backlog.length < PROC_BACKLOG_CAP) {
        backlog.push(frame);
        this._procBacklog.set(frame.channel, backlog);
      }
      return;
    }
    if (frame.type === 'proc.data') {
      proc._onData(frame.stream, Buffer.from(frame.data, 'base64'));
    } else {
      this._procs.delete(frame.channel);
      proc._onExit(frame.code, frame.signal);
    }
  }

  private _onTransportClosed(reason: RtsClientCloseInfo['reason'], error?: Error): void {
    if (this._state === 'closed') return;
    this._state = 'closed';
    if (error !== undefined) {
      this._settleHello(error);
    } else {
      this._settleHello(new RtsError('ECLOSED', 'transport closed during handshake'));
    }
    for (const [id, pending] of this._pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(
        new RtsError(
          'ECLOSED',
          `transport closed before reply to call #${String(id)}${error !== undefined ? `: ${error.message}` : ''}`,
        ),
      );
    }
    this._pending.clear();
    for (const proc of this._procs.values()) {
      proc._onTransportClosed();
    }
    this._procs.clear();
    this._procBacklog.clear();
    this._decoder.destroy();
    if (reason !== 'closed') {
      this._writable.destroy();
    }
    this._options.onClose?.({ reason, error: error?.message });
  }

  /** @internal */
  _procStdin(channel: number, chunk: Buffer, callback: (error?: Error | null) => void): void {
    if (this._state !== 'open') {
      callback(new RtsError('ECLOSED', 'client is not connected'));
      return;
    }
    void (async () => {
      try {
        await this._send({ type: 'proc.stdin', channel, data: chunk.toString('base64') });
        callback();
      } catch (error) {
        callback(error as Error);
      }
    })();
  }

  /** @internal */
  _procStdinEof(channel: number): void {
    if (this._state !== 'open') return;
    void this._send({ type: 'proc.stdin.eof', channel }).catch(() => {});
  }

  /** @internal */
  _procKill(channel: number, signal?: string): void {
    if (this._state !== 'open') return;
    void this._send({ type: 'proc.kill', channel, signal }).catch(() => {});
  }
}
