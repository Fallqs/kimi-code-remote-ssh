import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RtsError } from '#/client/client';
import { RTS_VERSION } from '#/protocol/frames';

import {
  POSIX_ONLY,
  closePair,
  createLinkedPair,
  makeTempDir,
  removeTempDir,
  type LinkedPair,
} from './helpers';

describe('server: fs ops', () => {
  let pair: LinkedPair;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    pair = await createLinkedPair();
  });

  afterEach(async () => {
    await closePair(pair);
    await removeTempDir(tempDir);
  });

  it('hello carries facts and the server version', () => {
    expect(pair.client.facts.shellName).toBe('bash');
    expect(pair.client.facts.pathClass).toBe('posix');
    expect(typeof pair.client.facts.homeDir).toBe('string');
    expect(typeof pair.client.facts.osKind).toBe('string');
    expect(pair.client.version).toBe(RTS_VERSION);
  });

  it('writeText + readText round-trip with unicode', async () => {
    const file = join(tempDir, 'hello.txt');
    await pair.client.fs.writeText(file, 'héllo\n第二行');
    expect(await pair.client.fs.readText(file)).toBe('héllo\n第二行');
  });

  it('writeText append appends', async () => {
    const file = join(tempDir, 'append.txt');
    await pair.client.fs.writeText(file, 'one\n');
    await pair.client.fs.writeText(file, 'two\n', { append: true });
    expect(await pair.client.fs.readText(file)).toBe('one\ntwo\n');
  });

  it('writeText does not create parent directories', async () => {
    const file = join(tempDir, 'missing-parent', 'x.txt');
    await expect(pair.client.fs.writeText(file, 'x')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('readText honors the encoding parameter', async () => {
    const file = join(tempDir, 'latin.txt');
    await writeFile(file, Buffer.from([0x61, 0xe9, 0x62]));
    expect(await pair.client.fs.readText(file, { encoding: 'latin1' })).toBe('aéb');
  });

  it('readBytes reads whole files and honors maxBytes', async () => {
    const file = join(tempDir, 'bytes.bin');
    await pair.client.fs.writeText(file, '0123456789');
    expect(await pair.client.fs.readBytes(file)).toEqual(Buffer.from('0123456789'));
    expect(await pair.client.fs.readBytes(file, { maxBytes: 4 })).toEqual(Buffer.from('0123'));
  });

  it('readLines splits LF/CRLF without terminators', async () => {
    const file = join(tempDir, 'lines.txt');
    await pair.client.fs.writeText(file, 'a\nb\r\nc\n');
    expect(await pair.client.fs.readLines(file)).toEqual(['a', 'b', 'c']);
    await pair.client.fs.writeText(file, 'single');
    expect(await pair.client.fs.readLines(file)).toEqual(['single']);
    await pair.client.fs.writeText(file, '');
    expect(await pair.client.fs.readLines(file)).toEqual([]);
  });

  it('stat reports files and directories', async () => {
    const file = join(tempDir, 'stat.txt');
    await pair.client.fs.writeText(file, '12345');

    const fileStat = await pair.client.fs.stat(file);
    expect(fileStat.isFile).toBe(true);
    expect(fileStat.isDirectory).toBe(false);
    expect(fileStat.isSymlink).toBe(false);
    expect(fileStat.stSize).toBe(5);
    expect(typeof fileStat.stMode).toBe('number');
    expect(typeof fileStat.stIno).toBe('number');
    expect(typeof fileStat.stMtime).toBe('number');

    const dirStat = await pair.client.fs.stat(tempDir);
    expect(dirStat.isDirectory).toBe(true);
    expect(dirStat.isFile).toBe(false);
  });

  it.skipIf(!POSIX_ONLY)('stat follows symlinks by default and not on request', async () => {
    const target = join(tempDir, 'target.txt');
    const link = join(tempDir, 'link.txt');
    await pair.client.fs.writeText(target, 'data');
    await symlink(target, link);

    const followed = await pair.client.fs.stat(link);
    expect(followed.isSymlink).toBe(true);
    expect(followed.isFile).toBe(true);

    const notFollowed = await pair.client.fs.stat(link, { followSymlinks: false });
    expect(notFollowed.isSymlink).toBe(true);
    expect(notFollowed.isFile).toBe(false);
  });

  it('readdir returns entries with type flags', async () => {
    await pair.client.fs.writeText(join(tempDir, 'a.txt'), 'a');
    await pair.client.fs.mkdir(join(tempDir, 'sub'));

    const entries = await pair.client.fs.readdir(tempDir);
    const byName = new Map(entries.map(entry => [entry.name, entry]));
    expect(byName.get('a.txt')).toMatchObject({ isFile: true, isDirectory: false, isSymlink: false });
    expect(byName.get('sub')).toMatchObject({ isFile: false, isDirectory: true, isSymlink: false });
  });

  it('mkdir creates parents recursively and reports EEXIST', async () => {
    const nested = join(tempDir, 'a', 'b', 'c');
    await pair.client.fs.mkdir(nested, { recursive: true });
    expect(await pair.client.fs.exists(nested)).toBe(true);
    await expect(pair.client.fs.mkdir(tempDir)).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('remove applies force semantics', async () => {
    const tree = join(tempDir, 'tree');
    await pair.client.fs.mkdir(join(tree, 'child'), { recursive: true });
    await pair.client.fs.writeText(join(tree, 'child', 'f.txt'), 'f');

    await pair.client.fs.remove(tree, { recursive: true });
    expect(await pair.client.fs.exists(tree)).toBe(false);

    // A missing path is success.
    await pair.client.fs.remove(join(tempDir, 'never-existed'));
  });

  it.skipIf(!POSIX_ONLY)('remove without recursive refuses directories', async () => {
    const tree = join(tempDir, 'tree');
    await pair.client.fs.mkdir(tree);
    // (Windows dev quirk: node rm succeeds there; POSIX remotes EISDIR.)
    await expect(pair.client.fs.remove(tree)).rejects.toMatchObject({
      code: expect.stringContaining('EISDIR'),
    });
  });

  it('exists reports presence and absence', async () => {
    const file = join(tempDir, 'exists.txt');
    expect(await pair.client.fs.exists(file)).toBe(false);
    await pair.client.fs.writeText(file, 'x');
    expect(await pair.client.fs.exists(file)).toBe(true);
  });

  it('realpath resolves "."', async () => {
    expect(await pair.client.fs.realpath(join(tempDir, '.'))).toBe(tempDir);
  });

  it('maps ENOENT errors', async () => {
    await expect(pair.client.fs.readText(join(tempDir, 'missing.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(pair.client.fs.stat(join(tempDir, 'missing.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.skipIf(!POSIX_ONLY)('maps ENOTDIR errors', async () => {
    const file = join(tempDir, 'file.txt');
    await pair.client.fs.writeText(file, 'x');
    await expect(pair.client.fs.readdir(file)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('maps invalid params to EINVAL', async () => {
    await expect(pair.client.fs.readText('')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(pair.client.call('fs.stat', {})).rejects.toMatchObject({ code: 'EINVAL' });
  });

  it('replies EOPNOTSUPP for unknown ops', async () => {
    await expect(pair.client.call('no.such.op', {})).rejects.toMatchObject({
      code: 'EOPNOTSUPP',
    });
  });

  it('err replies reject with an RtsError carrying the code', async () => {
    const error = await pair.client.fs.readText(join(tempDir, 'missing.txt')).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RtsError);
    expect((error as RtsError).code).toBe('ENOENT');
    expect((error as RtsError).message).toContain('missing.txt');
  });
});
