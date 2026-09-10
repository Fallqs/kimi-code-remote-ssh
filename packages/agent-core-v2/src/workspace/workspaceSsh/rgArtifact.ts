import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

import type { RemotePlatformKey, RgArtifactProvider } from '@moonshot-ai/remote-ssh';
import { join } from 'pathe';

import {
  extractRgFromTar,
  fetchRgArchiveBuffer,
  getShareDir,
} from '#/os/backends/node-local/tools/rgLocator';

const REMOTE_PLATFORM_TARGET: Record<RemotePlatformKey, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

export interface RgArtifactProviderOptions {
  readonly shareDir?: string;
  readonly fetchArchive?: (target: string) => Promise<Buffer>;
  readonly extractRg?: (archive: Buffer, target: string) => Promise<Buffer>;
}

export function createRgArtifactProvider(
  options: RgArtifactProviderOptions = {},
): RgArtifactProvider {
  const shareDir = options.shareDir ?? getShareDir();
  const fetchArchive = options.fetchArchive ?? fetchRgArchiveBuffer;
  const extractRg = options.extractRg ?? extractRgFromTar;
  return async (platform) => {
    const target = REMOTE_PLATFORM_TARGET[platform];
    const cacheDir = join(shareDir, 'rg-bin', platform);
    const cachePath = join(cacheDir, 'rg');
    if (existsSync(cachePath)) {
      return readFile(cachePath);
    }
    const archive = await fetchArchive(target);
    const binary = await extractRg(archive, target);
    await mkdir(cacheDir, { recursive: true });
    const staged = join(cacheDir, `.rg-${randomUUID()}.tmp`);
    await writeFile(staged, binary, { mode: 0o755 });
    await rename(staged, cachePath);
    return binary;
  };
}
