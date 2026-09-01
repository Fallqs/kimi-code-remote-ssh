import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { RtsClient } from '#/client/client';
import { RTS_VERSION } from '#/protocol/frames';

import {
  BASH,
  POSIX_ONLY,
  collectOutput,
  isPidGone,
  makeTempDir,
  removeTempDir,
  waitForCondition,
  waitForExit,
} from './helpers';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const rtsBundle = join(packageRoot, 'dist', 'rts.js');

/**
 * Deployment-shape smoke test: the built single-file bundle runs under
 * plain `node dist/rts.js`, speaks the protocol over stdio, and cleans up
 * its process groups when the pipe drops.
 */
describe('bundle smoke: node dist/rts.js', () => {
  beforeAll(() => {
    execSync('pnpm run build', { cwd: packageRoot, stdio: 'pipe' });
  }, 120_000);

  it('embeds the RTS source for packaged builds', async () => {
    // Packaged builds (the bundled CLI, the SEA binary) deploy from the
    // source embedded via `#/generated/rts-bundle`; it must match the
    // on-disk bundle byte for byte.
    const { RTS_BUNDLE_SOURCE } = await import('#/generated/rts-bundle');
    expect(RTS_BUNDLE_SOURCE).toBe(readFileSync(rtsBundle, 'utf-8'));
  });

  it('handshakes, does an fs round-trip, spawns a process, exits on EOF', async () => {
    const child = spawn(process.execPath, [rtsBundle], { stdio: ['pipe', 'pipe', 'pipe'] });
    let serverStderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      serverStderr += chunk.toString('utf8');
    });

    const client = await RtsClient.connect({ readable: child.stdout, writable: child.stdin });
    expect(client.facts.shellName).toBe('bash');
    expect(client.facts.pathClass).toBe('posix');
    expect(client.version).toBe(RTS_VERSION);

    const tempDir = await makeTempDir();
    try {
      const file = join(tempDir, 'smoke.txt');
      await client.fs.writeText(file, 'smoke');
      expect(await client.fs.readText(file)).toBe('smoke');
      expect(await client.fs.exists(file)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }

    // Spawning node itself works on any remote that satisfies the node
    // prerequisite, regardless of bash availability.
    const proc = await client.spawn({
      cmd: process.execPath,
      args: ['-e', 'console.log("hi")'],
    });
    const out = collectOutput(proc.stdout);
    expect(await proc.wait()).toBe(0);
    expect((await out.done).trim()).toBe('hi');

    await client.close();
    const code = await waitForExit(child);
    expect(code, `server stderr:\n${serverStderr}`).toBe(0);
  });

  it.skipIf(BASH === undefined)('spawns bash -c echo hi', async () => {
    const child = spawn(process.execPath, [rtsBundle], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();

    const client = await RtsClient.connect({ readable: child.stdout, writable: child.stdin });
    const proc = await client.spawn({ cmd: BASH!, args: ['-c', 'echo hi'] });
    const out = collectOutput(proc.stdout);
    expect(await proc.wait()).toBe(0);
    expect(await out.done).toBe('hi\n');

    await client.close();
    expect(await waitForExit(child)).toBe(0);
  });

  it.skipIf(!POSIX_ONLY || BASH === undefined)(
    'stdin EOF kills remote process groups and the server exits',
    async () => {
      const child = spawn(process.execPath, [rtsBundle], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.resume();

      const client = await RtsClient.connect({ readable: child.stdout, writable: child.stdin });
      const proc = await client.spawn({
        cmd: BASH!,
        args: ['-c', 'sleep 300 & echo $!; wait'],
      });
      const out = collectOutput(proc.stdout);
      await out.waitFor('\n');
      const sleepPid = Number.parseInt(out.text().trim(), 10);
      expect(sleepPid).toBeGreaterThan(0);

      // The ssh pipe drops: stdin EOF on the server.
      child.stdin.end();

      expect(await waitForExit(child)).toBe(0);
      await waitForCondition(() => isPidGone(proc.pid) && isPidGone(sleepPid));
      await client.close();
    },
  );
});
