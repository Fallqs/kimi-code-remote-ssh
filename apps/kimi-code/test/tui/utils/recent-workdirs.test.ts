import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadRecentWorkdirs, recordRecentWorkdir } from '#/tui/utils/recent-workdirs';
import { getRecentWorkdirsFile } from '#/utils/paths';

const originalEnv = { ...process.env };

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kimi-recent-workdirs-'));
  process.env['KIMI_CODE_HOME'] = home;
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await rm(home, { recursive: true, force: true });
});

describe('loadRecentWorkdirs', () => {
  it('returns an empty list when the file is missing', () => {
    expect(loadRecentWorkdirs()).toEqual([]);
  });

  it('returns an empty list when the file is corrupt', async () => {
    await writeFile(getRecentWorkdirsFile(), 'not json {{{', 'utf-8');
    expect(loadRecentWorkdirs()).toEqual([]);
  });

  it('returns an empty list when the file does not hold a string array', async () => {
    await writeFile(getRecentWorkdirsFile(), '{"workdirs":[]}', 'utf-8');
    expect(loadRecentWorkdirs()).toEqual([]);
  });

  it('drops non-string and empty entries from a stored array', async () => {
    await writeFile(
      getRecentWorkdirsFile(),
      JSON.stringify(['/proj/a', 42, '', null, 'ssh://host/path']),
      'utf-8',
    );
    expect(loadRecentWorkdirs()).toEqual(['/proj/a', 'ssh://host/path']);
  });
});

describe('recordRecentWorkdir', () => {
  it('persists entries most-recent-first across a reload', () => {
    recordRecentWorkdir('/proj/a');
    recordRecentWorkdir('/proj/b');
    recordRecentWorkdir('ssh://user@host:22/home/user/proj');

    expect(loadRecentWorkdirs()).toEqual([
      'ssh://user@host:22/home/user/proj',
      '/proj/b',
      '/proj/a',
    ]);
  });

  it('dedupes by moving a re-recorded entry to the front', () => {
    recordRecentWorkdir('/proj/a');
    recordRecentWorkdir('/proj/b');
    recordRecentWorkdir('/proj/a');

    expect(loadRecentWorkdirs()).toEqual(['/proj/a', '/proj/b']);
  });

  it('caps the list at 30 entries', () => {
    for (let i = 0; i < 35; i++) {
      recordRecentWorkdir(`/proj/${String(i)}`);
    }

    const loaded = loadRecentWorkdirs();
    expect(loaded).toHaveLength(30);
    expect(loaded[0]).toBe('/proj/34');
    expect(loaded[29]).toBe('/proj/5');
  });

  it('stores ssh:// specs verbatim', () => {
    recordRecentWorkdir('ssh://gpu24/home/user/proj');

    expect(loadRecentWorkdirs()).toEqual(['ssh://gpu24/home/user/proj']);
  });

  it('ignores blank workdirs', () => {
    recordRecentWorkdir('   ');

    expect(loadRecentWorkdirs()).toEqual([]);
  });

  it('recovers from a corrupt file by overwriting it', async () => {
    await writeFile(getRecentWorkdirsFile(), 'not json', 'utf-8');

    recordRecentWorkdir('/proj/a');

    expect(loadRecentWorkdirs()).toEqual(['/proj/a']);
  });
});
