import { symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  POSIX_ONLY,
  closePair,
  createLinkedPair,
  makeTempDir,
  removeTempDir,
  type LinkedPair,
} from './helpers';

/**
 * Parity cases for the pure-JS glob walk, mirroring
 * packages/kaos/test/e2e/glob-boundaries-parity.test.ts and the walk
 * semantics of packages/kaos/src/local.ts.
 */
describe('server: fs.glob', () => {
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

  async function glob(pattern: string, options?: { caseSensitive?: boolean }): Promise<string[]> {
    const matches = await pair.client.fs.glob(tempDir, pattern, options);
    return matches.toSorted();
  }

  it('** traverses hidden directories and yields each nested match only once', async () => {
    await pair.client.fs.mkdir(join(tempDir, 'visible', 'nested'), { recursive: true });
    await pair.client.fs.mkdir(join(tempDir, '.hidden-root'));
    await pair.client.fs.mkdir(join(tempDir, 'visible', '.hidden-dir'), { recursive: true });

    await pair.client.fs.writeText(join(tempDir, 'root-visible.txt'), 'root-visible');
    await pair.client.fs.writeText(join(tempDir, '.hidden-root', 'root-hidden.txt'), 'root-hidden');
    await pair.client.fs.writeText(join(tempDir, 'visible', 'nested', 'deep.txt'), 'deep');
    await pair.client.fs.writeText(join(tempDir, 'visible', '.hidden-dir', 'secret.txt'), 'secret');
    await pair.client.fs.writeText(join(tempDir, 'visible', '.hidden-dir', 'skip.log'), 'skip');

    const results = await glob('**/*.txt');

    expect(results).toHaveLength(4);
    expect(new Set(results).size).toBe(4);
    expect(results).toEqual(
      [
        join(tempDir, '.hidden-root', 'root-hidden.txt'),
        join(tempDir, 'root-visible.txt'),
        join(tempDir, 'visible', '.hidden-dir', 'secret.txt'),
        join(tempDir, 'visible', 'nested', 'deep.txt'),
      ].toSorted(),
    );
  });

  it('root-level glob includes hidden dotfiles', async () => {
    await pair.client.fs.writeText(join(tempDir, '.hidden.txt'), 'hidden');
    await pair.client.fs.writeText(join(tempDir, 'visible.txt'), 'visible');
    await pair.client.fs.writeText(join(tempDir, 'visible.log'), 'log');

    expect(await glob('*.txt')).toEqual(
      [join(tempDir, '.hidden.txt'), join(tempDir, 'visible.txt')].toSorted(),
    );
  });

  it('trailing ** yields directories, files, and the base itself', async () => {
    await pair.client.fs.mkdir(join(tempDir, 'a', 'sub'), { recursive: true });
    await pair.client.fs.writeText(join(tempDir, 'a', 'x.txt'), 'x');
    await pair.client.fs.writeText(join(tempDir, 'a', 'sub', 'y.txt'), 'y');

    expect(await glob('**')).toEqual(
      [
        tempDir,
        join(tempDir, 'a'),
        join(tempDir, 'a', 'sub'),
        join(tempDir, 'a', 'x.txt'),
        join(tempDir, 'a', 'sub', 'y.txt'),
      ].toSorted(),
    );
  });

  it('* does not cross directory boundaries', async () => {
    await pair.client.fs.mkdir(join(tempDir, 'dir'));
    await pair.client.fs.writeText(join(tempDir, 'a.txt'), 'a');
    await pair.client.fs.writeText(join(tempDir, 'dir', 'b.txt'), 'b');

    expect(await glob('*.txt')).toEqual([join(tempDir, 'a.txt')]);
    expect(await glob('*/*.txt')).toEqual([join(tempDir, 'dir', 'b.txt')]);
  });

  it('? matches exactly one character', async () => {
    await pair.client.fs.writeText(join(tempDir, 'a.txt'), '');
    await pair.client.fs.writeText(join(tempDir, 'ab.txt'), '');
    await pair.client.fs.writeText(join(tempDir, 'abc.txt'), '');

    expect(await glob('a?.txt')).toEqual([join(tempDir, 'ab.txt')]);
  });

  it('[...] classes and [!...] negation', async () => {
    await pair.client.fs.writeText(join(tempDir, 'x1.txt'), '');
    await pair.client.fs.writeText(join(tempDir, 'x2.txt'), '');
    await pair.client.fs.writeText(join(tempDir, 'x3.txt'), '');

    expect(await glob('x[12].txt')).toEqual(
      [join(tempDir, 'x1.txt'), join(tempDir, 'x2.txt')].toSorted(),
    );
    expect(await glob('x[!1].txt')).toEqual(
      [join(tempDir, 'x2.txt'), join(tempDir, 'x3.txt')].toSorted(),
    );
  });

  it('backslash escapes match metacharacters literally', async () => {
    await pair.client.fs.writeText(join(tempDir, 'literal[1].txt'), '');
    await pair.client.fs.writeText(join(tempDir, 'literal1.txt'), '');

    expect(await glob('literal\\[1\\].txt')).toEqual([join(tempDir, 'literal[1].txt')]);
  });

  it('caseSensitive: false matches across case', async () => {
    await pair.client.fs.writeText(join(tempDir, 'ReadMe.TXT'), '');

    expect(await glob('*.txt')).toEqual([]);
    expect(await glob('*.txt', { caseSensitive: false })).toEqual([join(tempDir, 'ReadMe.TXT')]);
  });

  it('a missing base yields no matches for file patterns', async () => {
    const missing = join(tempDir, 'missing');
    expect(await pair.client.fs.glob(missing, '**/*.txt')).toEqual([]);
    // Parity quirk with kaos: a trailing `**` yields the base itself as its
    // zero-directory match even when the base is unreadable.
    expect(await pair.client.fs.glob(missing, '**')).toEqual([missing]);
  });

  it.skipIf(!POSIX_ONLY)('symlink cycles are detected and not followed', async () => {
    await pair.client.fs.mkdir(join(tempDir, 'real'));
    await pair.client.fs.writeText(join(tempDir, 'real', 'x.txt'), 'x');
    await symlink(tempDir, join(tempDir, 'loop'));

    const results = await glob('**');
    expect(results).toEqual([tempDir, join(tempDir, 'real'), join(tempDir, 'real', 'x.txt')].toSorted());
    expect(await glob('**/*.txt')).toEqual([join(tempDir, 'real', 'x.txt')]);
  });
});
