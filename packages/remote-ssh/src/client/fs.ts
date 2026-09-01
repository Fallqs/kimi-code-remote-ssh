import type { OpName, RtsDirEntry, RtsStat } from '#/protocol/ops';

/** @internal */
export type FsCallFn = (op: OpName, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Typed per-op wrappers over `RtsClient.call`, mirroring the fs op set of
 * the RTS protocol.
 */
export class RtsFs {
  /** @internal */
  constructor(private readonly _call: FsCallFn) {}

  async readText(path: string, options?: { encoding?: BufferEncoding }): Promise<string> {
    const result = await this._call('fs.readText', { path, encoding: options?.encoding });
    return (result as { text: string }).text;
  }

  async writeText(path: string, text: string, options?: { append?: boolean }): Promise<void> {
    await this._call('fs.writeText', { path, text, append: options?.append });
  }

  async readBytes(path: string, options?: { maxBytes?: number }): Promise<Buffer> {
    const result = await this._call('fs.readBytes', { path, maxBytes: options?.maxBytes });
    return Buffer.from((result as { data: string }).data, 'base64');
  }

  async readLines(path: string): Promise<string[]> {
    const result = await this._call('fs.readLines', { path });
    return (result as { lines: string[] }).lines;
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<RtsStat> {
    const result = await this._call('fs.stat', { path, followSymlinks: options?.followSymlinks });
    return (result as { stat: RtsStat }).stat;
  }

  async readdir(path: string): Promise<RtsDirEntry[]> {
    const result = await this._call('fs.readdir', { path });
    return (result as { entries: RtsDirEntry[] }).entries;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this._call('fs.mkdir', { path, recursive: options?.recursive });
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this._call('fs.remove', { path, recursive: options?.recursive });
  }

  async exists(path: string): Promise<boolean> {
    const result = await this._call('fs.exists', { path });
    return (result as { exists: boolean }).exists;
  }

  async realpath(path: string): Promise<string> {
    const result = await this._call('fs.realpath', { path });
    return (result as { path: string }).path;
  }

  /** Pure-JS recursive walk on the remote; yields full joined paths, dotfiles included. */
  async glob(path: string, pattern: string, options?: { caseSensitive?: boolean }): Promise<string[]> {
    const result = await this._call('fs.glob', {
      path,
      pattern,
      caseSensitive: options?.caseSensitive,
    });
    return (result as { matches: string[] }).matches;
  }
}
