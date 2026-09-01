import { once } from 'node:events';
import { Transform, type TransformCallback, type Writable } from 'node:stream';

import type { Frame } from '#/protocol/frames';

/** Inbound frame size cap; a peer sending more is considered broken. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const NEWLINE = 0x0a;

export class FrameCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameCodecError';
  }
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame) + '\n';
}

/**
 * Byte stream → parsed frames. Writable side accepts arbitrary chunking
 * (frames may split across chunks, multiple frames per chunk); readable side
 * emits one object per complete NDJSON line.
 */
export class FrameDecoder extends Transform {
  private _buffer: Buffer = Buffer.alloc(0);
  private readonly _maxFrameBytes: number;

  constructor(options?: { maxFrameBytes?: number }) {
    super({ readableObjectMode: true });
    this._maxFrameBytes = options?.maxFrameBytes ?? MAX_FRAME_BYTES;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

    let start = 0;
    let error: FrameCodecError | undefined;
    for (;;) {
      const newline = this._buffer.indexOf(NEWLINE, start);
      if (newline === -1) break;
      const line = this._buffer.subarray(start, newline);
      start = newline + 1;
      if (line.length > this._maxFrameBytes) {
        error = new FrameCodecError(`frame exceeds ${this._maxFrameBytes} bytes`);
        break;
      }
      if (line.length === 0) continue;
      let frame: Frame;
      try {
        frame = JSON.parse(line.toString('utf8')) as Frame;
      } catch {
        error = new FrameCodecError('invalid JSON frame');
        break;
      }
      this.push(frame);
    }

    if (error === undefined && this._buffer.length - start > this._maxFrameBytes) {
      // No complete line yet and the buffer already exceeds the cap: the
      // frame can only grow further, so reject it now instead of buffering.
      error = new FrameCodecError(`frame exceeds ${this._maxFrameBytes} bytes`);
    }

    // Copy the remainder when it shrinks to a small tail, so subarray views
    // don't pin a large parent buffer between chunks.
    this._buffer =
      start === 0
        ? this._buffer
        : this._buffer.length - start < 64 * 1024
          ? Buffer.from(this._buffer.subarray(start))
          : this._buffer.subarray(start);

    callback(error);
  }

  override _flush(callback: TransformCallback): void {
    // A non-empty remainder at EOF means the peer cut a frame in half.
    if (this._buffer.length > 0 && this._buffer.toString('utf8').trim().length > 0) {
      callback(new FrameCodecError('stream ended mid-frame'));
      return;
    }
    callback();
  }
}

/**
 * Frame → byte stream writer honoring transport backpressure: `write()`
 * resolves once the frame has been accepted by the kernel (drain awaited).
 */
export class FrameWriter {
  private readonly _stream: Writable;
  private readonly _maxFrameBytes: number;

  constructor(stream: Writable, options?: { maxFrameBytes?: number }) {
    this._stream = stream;
    this._maxFrameBytes = options?.maxFrameBytes ?? MAX_FRAME_BYTES;
  }

  async write(frame: Frame): Promise<void> {
    const line = encodeFrame(frame);
    if (Buffer.byteLength(line) > this._maxFrameBytes) {
      // Checked before writing, so the stream never sees a partial frame.
      throw new FrameCodecError(`frame exceeds ${this._maxFrameBytes} bytes`);
    }
    if (this._stream.destroyed) {
      throw new FrameCodecError('stream is destroyed');
    }
    if (!this._stream.write(line)) {
      // Rejects if the stream errors while waiting for the drain.
      await once(this._stream, 'drain');
    }
  }

  async end(): Promise<void> {
    if (this._stream.destroyed || this._stream.writableEnded) return;
    this._stream.end();
    await once(this._stream, 'finish');
  }
}
