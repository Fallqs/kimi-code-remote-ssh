import { spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';

import { RtsClient, type RtsClientOptions } from '#/client/client';
import type { RemoteFacts } from '#/protocol/frames';
import { RtsServer, type RtsServerOptions } from '#/server/server';

export const IS_POSIX = process.platform !== 'win32';
export const SKIP_POSIX_TESTS = process.env['KIMI_REMOTE_SSH_SKIP_POSIX_TESTS'] === '1';

export function findBash(): string | undefined {
  if (SKIP_POSIX_TESTS) return undefined;
  const probe = spawnSync('bash', ['-c', 'true'], { stdio: 'ignore' });
  return probe.status === 0 ? 'bash' : undefined;
}

/** Set when bash is resolvable; bash-dependent tests may run on any OS. */
export const BASH = findBash();

/**
 * Gate for semantics bash alone cannot provide on Windows (process-group
 * kills, symlinks): POSIX-only tests.
 */
export const POSIX_ONLY = IS_POSIX && !SKIP_POSIX_TESTS;

export function fakeFacts(): RemoteFacts {
  return {
    osKind: 'linux',
    osArch: 'x64',
    osVersion: 'fake',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/home/fake',
  };
}

export interface LinkedPair {
  client: RtsClient;
  server: RtsServer;
  clientToServer: PassThrough;
  serverToClient: PassThrough;
}

/** Wire a client and a server together over an in-process byte pipe pair. */
export async function createLinkedPair(options?: {
  server?: Partial<RtsServerOptions>;
  client?: RtsClientOptions;
}): Promise<LinkedPair> {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const server = new RtsServer({
    input: clientToServer,
    output: serverToClient,
    cwd: options?.server?.cwd,
    log: options?.server?.log,
    version: options?.server?.version,
  });
  await server.start();
  const client = await RtsClient.connect(
    { readable: serverToClient, writable: clientToServer },
    options?.client,
  );
  return { client, server, clientToServer, serverToClient };
}

export async function closePair(pair: LinkedPair): Promise<void> {
  await pair.client.close();
  // The server sees its stdin EOF and shuts down on its own.
  await pair.server.waitClosed();
}

export async function makeTempDir(): Promise<string> {
  // realpath: macOS tmpdir is itself a symlink, and glob yields paths joined
  // onto the base exactly as given.
  return realpath(await mkdtemp(join(tmpdir(), 'remote-ssh-test-')));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function isPidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export async function waitForCondition(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) {
      throw new Error('waitForCondition timed out');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export async function readToEnd(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export interface OutputCollector {
  text(): string;
  waitFor(needle: string, timeoutMs?: number): Promise<void>;
  done: Promise<string>;
}

/**
 * Incremental stdout/stderr collector for proc tests: a single flowing-mode
 * consumer (async iterators and `data` listeners must not be mixed on one
 * stream) with substring waits.
 */
export function collectOutput(stream: Readable): OutputCollector {
  let text = '';
  let ended = false;
  interface Waiter {
    needle: string;
    resolve: () => void;
    timer: NodeJS.Timeout;
  }
  const waiters: Waiter[] = [];
  let resolveDone!: (value: string) => void;
  const done = new Promise<string>(resolve => {
    resolveDone = resolve;
  });
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      if (text.includes(waiter.needle)) {
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  });
  stream.on('end', () => {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      // Stream ended; resolve regardless and let the caller assert on text.
      waiter.resolve();
    }
    resolveDone(text);
  });
  return {
    text: () => text,
    waitFor(needle: string, timeoutMs = 5_000): Promise<void> {
      if (text.includes(needle) || ended) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${JSON.stringify(needle)} in stream output`));
        }, timeoutMs);
        waiters.push({ needle, resolve, timer });
      });
    },
    done,
  };
}

export async function waitForExit(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const [code] = await Promise.race([
    once(child, 'exit'),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('child process did not exit in time'));
      }, timeoutMs);
    }),
  ]);
  return code;
}
