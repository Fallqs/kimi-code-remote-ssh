import type { Readable, Writable } from 'node:stream';

import { FrameCodecError, FrameDecoder, FrameWriter } from '#/protocol/codec';
import {
  RTS_PROTOCOL,
  RTS_VERSION,
  type CallFrame,
  type ClientFrame,
  type ServerFrame,
} from '#/protocol/frames';
import { probeFacts } from '#/server/facts';
import { OP_HANDLERS, type OpHandler } from '#/server/ops';
import { ProcMux } from '#/server/proc';

export interface RtsServerOptions {
  /** Transport bytes client → server (e.g. process.stdin). */
  input: Readable;
  /** Transport bytes server → client (e.g. process.stdout). */
  output: Writable;
  /** Default cwd for proc.spawn; defaults to the server's start cwd. */
  cwd?: string;
  /** Diagnostic sink for non-protocol messages; defaults to a noop. */
  log?: (message: string) => void;
  /** Version string reported in the hello frame. */
  version?: string;
}

export interface RtsServerCloseInfo {
  reason: 'eof' | 'error' | 'shutdown';
  error?: string;
}

/**
 * The Remote Tool Server: sends the hello frame on start, dispatches `call`
 * frames to the op handlers, and routes proc frames to the process mux.
 *
 * When the input stream ends (the SSH pipe dropped) or breaks, the server
 * SIGKILLs every live process group and closes the output — a dropped
 * connection must never leave stray processes on the remote.
 */
export class RtsServer {
  private readonly _writer: FrameWriter;
  private readonly _decoder: FrameDecoder;
  private readonly _mux: ProcMux;
  private readonly _handlers: Record<string, OpHandler>;
  private readonly _log: (message: string) => void;
  private readonly _version: string;
  private _closed = false;
  private readonly _waitClosedPromise: Promise<RtsServerCloseInfo>;
  private _resolveClosed!: (info: RtsServerCloseInfo) => void;

  constructor(options: RtsServerOptions) {
    this._log = options.log ?? (() => {});
    this._version = options.version ?? RTS_VERSION;
    this._writer = new FrameWriter(options.output);
    this._mux = new ProcMux(
      frame => this._send(frame),
      options.cwd ?? process.cwd(),
      this._log,
    );
    this._handlers = {
      ...OP_HANDLERS,
      'proc.spawn': params => this._mux.spawn(params),
    };
    this._waitClosedPromise = new Promise(resolve => {
      this._resolveClosed = resolve;
    });

    this._decoder = new FrameDecoder();
    options.input.pipe(this._decoder);
    this._decoder.on('error', error => {
      this.shutdown('error', error);
    });
    this._decoder.on('end', () => {
      this.shutdown('eof');
    });
    // stream.pipe does not forward source errors; listen on both ends. A
    // bare 'close' (destroy without error) is as terminal as an EOF.
    options.input.on('error', error => {
      this.shutdown('error', error);
    });
    options.input.on('close', () => {
      this.shutdown('eof');
    });
    options.output.on('error', error => {
      this.shutdown('error', error);
    });
    options.output.on('close', () => {
      this.shutdown('eof');
    });
  }

  /** Probe host facts and send the hello frame. */
  async start(): Promise<void> {
    const facts = await probeFacts();
    await this._send({
      type: 'hello',
      protocol: RTS_PROTOCOL,
      version: this._version,
      facts,
    });
    // Dispatch starts only after the hello is on the wire, so it stays the
    // first frame even when the facts probe is slow; call frames that
    // arrived meanwhile are buffered inside the decoder.
    if (!this._closed) {
      this._decoder.on('data', frame => {
        // The server only ever receives client frames; the decoder types
        // both directions, and the default case logs protocol violations.
        this._onFrame(frame as ClientFrame);
      });
    }
  }

  waitClosed(): Promise<RtsServerCloseInfo> {
    return this._waitClosedPromise;
  }

  /** Kill all live process groups, end the output, and settle waitClosed. */
  shutdown(reason: RtsServerCloseInfo['reason'], error?: Error): void {
    if (this._closed) return;
    this._closed = true;
    this._mux.killAll('SIGKILL');
    // Frames queued before the close flush before the EOF; sends racing in
    // after this point are dropped by the _send guard.
    void this._writer
      .end()
      .catch(() => {})
      .finally(() => {
        this._resolveClosed({ reason, error: error?.message });
      });
  }

  private async _send(frame: ServerFrame): Promise<void> {
    if (this._closed) return;
    try {
      await this._writer.write(frame);
    } catch (error) {
      // A codec error (oversized reply) leaves the stream intact — the
      // caller converts it into an err frame. Anything else is a broken
      // transport.
      if (!(error instanceof FrameCodecError)) {
        this.shutdown('error', error as Error);
      }
      throw error;
    }
  }

  private _onFrame(frame: ClientFrame): void {
    switch (frame.type) {
      case 'call':
        void this._onCall(frame);
        break;
      case 'proc.stdin':
        this._mux.stdin(frame.channel, frame.data);
        break;
      case 'proc.stdin.eof':
        this._mux.stdinEof(frame.channel);
        break;
      case 'proc.kill':
        this._mux.kill(frame.channel, frame.signal);
        break;
      default:
        this._log(`ignoring unknown frame type ${String((frame as { type: unknown }).type)}`);
    }
  }

  private async _onCall(frame: CallFrame): Promise<void> {
    if (typeof frame.id !== 'number' || typeof frame.op !== 'string') {
      this._log('ignoring malformed call frame');
      return;
    }
    const handler = this._handlers[frame.op];
    if (handler === undefined) {
      await this._send({
        type: 'err',
        id: frame.id,
        code: 'EOPNOTSUPP',
        message: `unknown op: ${frame.op}`,
      });
      return;
    }
    try {
      const result = await handler(frame.params ?? {});
      await this._send({ type: 'ok', id: frame.id, result: result ?? {} });
    } catch (error) {
      await this._send({
        type: 'err',
        id: frame.id,
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Node system errors carry their errno (ENOENT, EACCES, ...) on `.code`. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'EINTERNAL';
}
