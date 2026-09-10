import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { RemotePlatformKey } from '@moonshot-ai/remote-ssh';
import { create as createTar } from 'tar';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RG_VERSION, extractRgFromTar } from '#/os/backends/node-local/tools/rgLocator';
import { createRgArtifactProvider } from '#/workspace/workspaceSsh/rgArtifact';

const EXPECTED_TARGETS: Record<RemotePlatformKey, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

async function buildRgTarGz(target: string, payload: Buffer): Promise<Buffer> {
  const fixture = await mkdtemp(join(tmpdir(), 'kimi-rg-fixture-'));
  try {
    const inner = join(fixture, `ripgrep-${RG_VERSION}-${target}`);
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'rg'), payload);
    writeFileSync(join(inner, 'README.md'), 'fixture');
    const archivePath = join(fixture, 'archive.tar.gz');
    await createTar({ gzip: true, file: archivePath, cwd: fixture }, [
      `ripgrep-${RG_VERSION}-${target}`,
    ]);
    return readFileSync(archivePath);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

describe('extractRgFromTar', () => {
  it('extracts the rg entry from a real tar.gz archive', async () => {
    const payload = Buffer.from('fake-rg-binary-bytes', 'utf8');
    const archive = await buildRgTarGz('x86_64-unknown-linux-musl', payload);

    const extracted = await extractRgFromTar(archive, 'x86_64-unknown-linux-musl');

    expect(extracted).toEqual(payload);
  });

  it('throws when the archive omits the rg binary', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'kimi-rg-fixture-'));
    try {
      writeFileSync(join(fixture, 'README.md'), 'no binary here');
      const archivePath = join(fixture, 'archive.tar.gz');
      await createTar({ gzip: true, file: archivePath, cwd: fixture }, ['README.md']);

      await expect(
        extractRgFromTar(readFileSync(archivePath), 'x86_64-unknown-linux-musl'),
      ).rejects.toThrow(/CDN content may have changed/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

describe('createRgArtifactProvider', () => {
  let shareDir: string;
  beforeEach(async () => {
    shareDir = await mkdtemp(join(tmpdir(), 'kimi-rg-artifact-'));
  });
  afterEach(async () => {
    await rm(shareDir, { recursive: true, force: true });
  });

  it('maps every remote platform key to its archive target triple', async () => {
    const fetchArchive = vi.fn(async () => Buffer.from('archive'));
    const extractRg = vi.fn(async () => Buffer.from('rg-binary'));
    const provider = createRgArtifactProvider({ shareDir, fetchArchive, extractRg });

    for (const [platform, target] of Object.entries(EXPECTED_TARGETS)) {
      await provider(platform as RemotePlatformKey);
      expect(fetchArchive).toHaveBeenCalledWith(target);
      expect(extractRg).toHaveBeenCalledWith(Buffer.from('archive'), target);
    }
    expect(fetchArchive).toHaveBeenCalledTimes(Object.keys(EXPECTED_TARGETS).length);
  });

  it('returns the cached buffer without fetching on a cache hit', async () => {
    const cached = Buffer.from('cached-rg-binary', 'utf8');
    const cacheDir = join(shareDir, 'rg-bin', 'linux-x64');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'rg'), cached);
    const fetchArchive = vi.fn(async () => {
      throw new Error('network must not be touched');
    });
    const provider = createRgArtifactProvider({ shareDir, fetchArchive });

    const result = await provider('linux-x64');

    expect(result).toEqual(cached);
    expect(fetchArchive).not.toHaveBeenCalled();
  });

  it('downloads, extracts, caches, and returns the binary on a cache miss', async () => {
    const payload = Buffer.from('fresh-rg-binary', 'utf8');
    const fetchArchive = vi.fn(async () => Buffer.from('archive-bytes'));
    const extractRg = vi.fn(async () => payload);
    const provider = createRgArtifactProvider({ shareDir, fetchArchive, extractRg });

    const result = await provider('darwin-arm64');

    expect(result).toEqual(payload);
    const cachePath = join(shareDir, 'rg-bin', 'darwin-arm64', 'rg');
    expect(await readFile(cachePath)).toEqual(payload);
    if (process.platform !== 'win32') {
      expect((await stat(cachePath)).mode & 0o111).not.toBe(0);
    }

    const again = await provider('darwin-arm64');
    expect(again).toEqual(payload);
    expect(fetchArchive).toHaveBeenCalledTimes(1);
  });

  it('extracts a real downloaded archive through the default extractor', async () => {
    const payload = Buffer.from('real-tar-rg-binary', 'utf8');
    const archive = await buildRgTarGz('aarch64-apple-darwin', payload);
    const fetchArchive = vi.fn(async () => archive);
    const provider = createRgArtifactProvider({ shareDir, fetchArchive });

    const result = await provider('darwin-arm64');

    expect(result).toEqual(payload);
    expect(await readFile(join(shareDir, 'rg-bin', 'darwin-arm64', 'rg'))).toEqual(payload);
  });
});
