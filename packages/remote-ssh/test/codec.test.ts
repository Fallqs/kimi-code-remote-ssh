import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  FrameCodecError,
  FrameDecoder,
  FrameWriter,
  MAX_FRAME_BYTES,
  encodeFrame,
} from '#/protocol/codec';
import type { Frame } from '#/protocol/frames';

async function decodeAll(...chunks: (string | Buffer)[]): Promise<Frame[]> {
  const decoder = new FrameDecoder();
  const frames: Frame[] = [];
  decoder.on('data', (frame: Frame) => frames.push(frame));
  for (const chunk of chunks) {
    decoder.write(chunk);
  }
  decoder.end();
  await once(decoder, 'end');
  return frames;
}

async function decodeError(...chunks: (string | Buffer)[]): Promise<Error> {
  const decoder = new FrameDecoder();
  decoder.on('data', () => {});
  const errorPromise = once(decoder, 'error');
  for (const chunk of chunks) {
    decoder.write(chunk);
  }
  decoder.end();
  const [error] = await errorPromise;
  return error as Error;
}

describe('protocol: frame codec', () => {
  it('round-trips a single frame', async () => {
    const frame: Frame = { type: 'call', id: 7, op: 'fs.exists', params: { path: '/tmp' } };
    const frames = await decodeAll(encodeFrame(frame));
    expect(frames).toEqual([frame]);
  });

  it('decodes multiple frames in one chunk', async () => {
    const f1: Frame = { type: 'ok', id: 1, result: {} };
    const f2: Frame = { type: 'proc.stdin.eof', channel: 3 };
    const f3: Frame = { type: 'err', id: 2, code: 'ENOENT', message: 'no such file' };
    const frames = await decodeAll(encodeFrame(f1) + encodeFrame(f2) + encodeFrame(f3));
    expect(frames).toEqual([f1, f2, f3]);
  });

  it('decodes a frame split across chunks', async () => {
    const frame: Frame = { type: 'proc.kill', channel: 1, signal: 'SIGKILL' };
    const encoded = encodeFrame(frame);
    const decoder = new FrameDecoder();
    const frames: Frame[] = [];
    decoder.on('data', (f: Frame) => frames.push(f));

    decoder.write(encoded.slice(0, 10));
    await new Promise(resolve => setImmediate(resolve));
    expect(frames).toHaveLength(0);

    decoder.write(encoded.slice(10));
    decoder.end();
    await once(decoder, 'end');
    expect(frames).toEqual([frame]);
  });

  it('preserves binary payloads via base64', async () => {
    const binary = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
    const frame: Frame = {
      type: 'proc.data',
      channel: 42,
      stream: 'stdout',
      data: binary.toString('base64'),
    };
    const [decoded] = await decodeAll(encodeFrame(frame));
    expect(decoded).toEqual(frame);
    const data = (decoded as { data: string }).data;
    expect(Buffer.from(data, 'base64')).toEqual(binary);
  });

  it('handles unicode content', async () => {
    const frame: Frame = { type: 'ok', id: 1, result: { text: 'héllo 第二行 🤖' } };
    expect(await decodeAll(encodeFrame(frame))).toEqual([frame]);
  });

  it('rejects invalid JSON', async () => {
    const error = await decodeError('{"type": "ok", oops\n');
    expect(error).toBeInstanceOf(FrameCodecError);
    expect(error.message).toContain('invalid JSON');
  });

  it('rejects a line longer than the frame cap', async () => {
    const decoder = new FrameDecoder({ maxFrameBytes: 64 });
    decoder.on('data', () => {});
    const errorPromise = once(decoder, 'error');
    decoder.write('x'.repeat(100) + '\n');
    const [error] = await errorPromise;
    expect(error).toBeInstanceOf(FrameCodecError);
    expect((error as Error).message).toContain('frame exceeds');
  });

  it('rejects a newline-less buffer once it exceeds the cap', async () => {
    const decoder = new FrameDecoder({ maxFrameBytes: 64 });
    decoder.on('data', () => {});
    const errorPromise = once(decoder, 'error');
    decoder.write('x'.repeat(50));
    decoder.write('y'.repeat(50));
    const [error] = await errorPromise;
    expect(error).toBeInstanceOf(FrameCodecError);
  });

  it('rejects a truncated frame at end of stream', async () => {
    const error = await decodeError('{"type":"ok","id":1');
    expect(error).toBeInstanceOf(FrameCodecError);
    expect(error.message).toContain('mid-frame');
  });

  it('accepts a frame near the default cap', async () => {
    const payload = 'a'.repeat(MAX_FRAME_BYTES - 200);
    const frame: Frame = { type: 'ok', id: 1, result: { text: payload } };
    const frames = await decodeAll(encodeFrame(frame));
    expect(frames).toEqual([frame]);
  });

  describe('FrameWriter', () => {
    const frame: Frame = { type: 'proc.stdin.eof', channel: 1 };

    it('awaits drain when the transport applies backpressure', async () => {
      const stream = new PassThrough({ highWaterMark: 16 });
      const writer = new FrameWriter(stream);

      let firstResolved = false;
      const first = writer.write(frame).then(() => {
        firstResolved = true;
      });
      const second = writer.write(frame);

      await new Promise(resolve => setImmediate(resolve));
      expect(firstResolved).toBe(false);

      // Drain the readable side so the writable side fires 'drain'.
      stream.resume();
      await first;
      await second;
      expect(firstResolved).toBe(true);
      stream.end();
    });

    it('refuses to write an oversized frame', async () => {
      const stream = new PassThrough();
      const writer = new FrameWriter(stream, { maxFrameBytes: 16 });
      await expect(writer.write(frame)).rejects.toBeInstanceOf(FrameCodecError);
      expect(stream.read()).toBeNull();
      stream.end();
    });

    it('rejects writes after the stream is destroyed', async () => {
      const stream = new PassThrough();
      const writer = new FrameWriter(stream);
      stream.destroy();
      await expect(writer.write(frame)).rejects.toBeInstanceOf(FrameCodecError);
    });

    it('writes frames atomically and in order', async () => {
      const stream = new PassThrough();
      const writer = new FrameWriter(stream);
      const frames: Frame[] = [
        { type: 'call', id: 1, op: 'a', params: {} },
        { type: 'call', id: 2, op: 'b', params: {} },
        { type: 'call', id: 3, op: 'c', params: {} },
      ];
      await Promise.all(frames.map(f => writer.write(f)));
      writer.end().catch(() => {});
      const decoder = new FrameDecoder();
      const decoded: Frame[] = [];
      decoder.on('data', (f: Frame) => decoded.push(f));
      stream.pipe(decoder);
      await once(decoder, 'end');
      expect(decoded).toEqual(frames);
    });
  });
});
