/**
 * Remote probe + deploy of the RTS over one-shot ssh execs.
 *
 * Everything runs through an {@link SshExec} — a pre-bound `ssh <conn args>
 * <remote command>` invoker — so the same code serves the first connect and
 * reconnects, and tests can drive it through a fake ssh.
 *
 * The remote command strings are FIXED constants (only `$HOME` is expanded,
 * server-side by the remote login shell); nothing user-controlled is ever
 * interpolated into them.
 *
 * Two deploy flavors share this module: the node-script flavor (the remote
 * runs `node rts.js`, requiring node >= 20 on its PATH) and the binary
 * flavor (a prebuilt SEA single-executable uploaded as `rts-bin` and run
 * directly, so the remote needs nothing installed).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Minimum node major required on the remote (matches the local engine floor). */
export const MIN_REMOTE_NODE_MAJOR = 20;

/** Deploy location on the remote; `$HOME` expands in the remote login shell. */
export const REMOTE_RTS_DIR = '$HOME/.kimi-code/remote-agent';
export const REMOTE_RTS_PATH = `${REMOTE_RTS_DIR}/rts.js`;
/** Remote command of the long-lived pipe: `node "$HOME/.../rts.js"`. */
export const REMOTE_PIPE_COMMAND = `node "${REMOTE_RTS_PATH}"`;
/**
 * Deploy command: tmp file + rename, so a half-written bundle never sits at
 * the live path when the connection drops mid-upload.
 */
export const REMOTE_DEPLOY_COMMAND =
  `mkdir -p "${REMOTE_RTS_DIR}" && cat > "${REMOTE_RTS_PATH}.tmp" && ` +
  `mv "${REMOTE_RTS_PATH}.tmp" "${REMOTE_RTS_PATH}"`;

// ── SEA binary flavor ──────────────────────────────────────────────────

/** Platform keys a prebuilt RTS binary can exist for (`sea/<key>/rts-bin`). */
export type RemotePlatformKey = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

/** Map `uname -sm` output to a platform key; null when unrecognized. */
export function parseUnamePlatform(stdout: string): RemotePlatformKey | null {
  const [os, arch] = stdout.trim().toLowerCase().split(/\s+/);
  const osKey = os === 'linux' || os === 'darwin' ? os : null;
  const archKey =
    arch === 'x86_64' || arch === 'amd64'
      ? 'x64'
      : arch === 'aarch64' || arch === 'arm64'
        ? 'arm64'
        : null;
  if (osKey === null || archKey === null) return null;
  return `${osKey}-${archKey}` as RemotePlatformKey;
}

/** Deploy location of the prebuilt binary on the remote. */
export const REMOTE_RTS_BIN_PATH = `${REMOTE_RTS_DIR}/rts-bin`;
/** Remote command of the long-lived pipe for the binary flavor. */
export const REMOTE_BIN_PIPE_COMMAND = `"${REMOTE_RTS_BIN_PATH}"`;
/**
 * Binary version probe: `--rts-version` (not `--version`, which a fused SEA
 * binary may let node's own argv handling claim).
 */
export const REMOTE_BIN_VERSION_COMMAND = `"${REMOTE_RTS_BIN_PATH}" --rts-version`;
/**
 * Binary deploy command: tmp file + chmod + rename — the same drop-safety
 * as {@link REMOTE_DEPLOY_COMMAND}, plus the executable bit.
 */
export const REMOTE_BIN_DEPLOY_COMMAND =
  `mkdir -p "${REMOTE_RTS_DIR}" && cat > "${REMOTE_RTS_BIN_PATH}.tmp" && ` +
  `chmod 755 "${REMOTE_RTS_BIN_PATH}.tmp" && ` +
  `mv "${REMOTE_RTS_BIN_PATH}.tmp" "${REMOTE_RTS_BIN_PATH}"`;

// ── one-shot ssh exec ──────────────────────────────────────────────────

export interface SshExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Exit code; 255 is OpenSSH's own connection-failure code. */
  readonly code: number;
}

export interface SshExecOptions {
  /** Bytes piped into the remote command's stdin (the deploy upload). */
  readonly stdin?: Buffer;
  readonly timeoutMs?: number;
}

/** Runs `ssh <pre-bound connection args> <remoteCommand>`; never throws on non-zero exit. */
export type SshExec = (remoteCommand: string, options?: SshExecOptions) => Promise<SshExecResult>;

export interface MakeSshExecOptions {
  /** Observes every exec result (error messages quote the last stderr). */
  readonly onResult?: (result: SshExecResult) => void;
}

/** Bind an {@link SshExec} to an ssh binary and pre-built connection args. */
export function makeSshExec(
  sshPath: string,
  connectionArgs: string[],
  options?: MakeSshExecOptions,
): SshExec {
  return (remoteCommand, execOptions) =>
    runSsh([...connectionArgs, remoteCommand], sshPath, execOptions, options?.onResult);
}

async function runSsh(
  argv: string[],
  sshPath: string,
  execOptions?: SshExecOptions,
  onResult?: (result: SshExecResult) => void,
): Promise<SshExecResult> {
  return new Promise<SshExecResult>((resolve, reject) => {
    const child: ChildProcess = spawn(sshPath, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = execOptions?.timeoutMs;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            settled = true;
            child.kill();
            reject(new Error(`ssh command timed out after ${String(timeoutMs)} ms`));
          }, timeoutMs);
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      outcome();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    // Writing to a dead child's stdin raises EPIPE asynchronously (remote
    // exited before consuming the upload); the exit code carries the failure.
    child.stdin?.on('error', () => {});
    child.on('error', (error: Error) => {
      settle(() => {
        reject(new Error(`failed to spawn ssh client "${sshPath}": ${error.message}`));
      });
    });
    child.on('close', (code: number | null) => {
      settle(() => {
        const result: SshExecResult = { stdout, stderr, code: code ?? 1 };
        onResult?.(result);
        resolve(result);
      });
    });
    if (execOptions?.stdin !== undefined) {
      child.stdin?.end(execOptions.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

// ── probe ──────────────────────────────────────────────────────────────

export interface RemoteProbeResult {
  /** `node --version` output (e.g. `v22.1.0`) when node >= 20 is on PATH; null otherwise. */
  readonly nodeVersion: string | null;
  /** Version of the deployed RTS bundle; null when absent or unrunnable. */
  readonly rtsVersion: string | null;
}

/** Parse `vMAJOR.MINOR.PATCH`; null when unparsable or below the minimum major. */
function parseNodeVersion(stdout: string): string | null {
  const match = /^v(\d+)\.\d+\.\d+/.exec(stdout.trim());
  if (match === null) return null;
  return Number.parseInt(match[1] ?? '0', 10) >= MIN_REMOTE_NODE_MAJOR ? match[0] : null;
}

function firstLine(stdout: string): string | null {
  const line = stdout.trim().split('\n')[0];
  return line === undefined || line === '' ? null : line;
}

/**
 * Probe the remote: node availability/version and the deployed bundle's RTS
 * version. Non-zero ssh exits (host down, node missing, bundle absent) map
 * to null fields; only spawn/timeout failures reject.
 */
export async function probeRemote(
  ssh: SshExec,
  options?: { timeoutMs?: number },
): Promise<RemoteProbeResult> {
  const node = await ssh('node --version', { timeoutMs: options?.timeoutMs });
  const nodeVersion = parseNodeVersion(node.code === 0 ? node.stdout : '');
  if (nodeVersion === null) {
    return { nodeVersion: null, rtsVersion: null };
  }
  const rts = await ssh(`node "${REMOTE_RTS_PATH}" --version`, { timeoutMs: options?.timeoutMs });
  return { nodeVersion, rtsVersion: rts.code === 0 ? firstLine(rts.stdout) : null };
}

/**
 * Probe the remote platform via `uname -sm`. Null when the exec fails (an
 * unreachable remote maps to ssh's exit 255 here) or the output is
 * unrecognized — callers treat null as "no binary artifact possible".
 */
export async function probeRemotePlatform(
  ssh: SshExec,
  options?: { timeoutMs?: number },
): Promise<RemotePlatformKey | null> {
  const uname = await ssh('uname -sm', { timeoutMs: options?.timeoutMs });
  return uname.code === 0 ? parseUnamePlatform(uname.stdout) : null;
}

/** Version of the deployed RTS binary; null when absent or unrunnable. */
export async function probeRemoteBin(
  ssh: SshExec,
  options?: { timeoutMs?: number },
): Promise<string | null> {
  const probe = await ssh(REMOTE_BIN_VERSION_COMMAND, { timeoutMs: options?.timeoutMs });
  return probe.code === 0 ? firstLine(probe.stdout) : null;
}

// ── deploy ─────────────────────────────────────────────────────────────

/** Upload the RTS bundle to {@link REMOTE_RTS_PATH} (tmp + rename). */
export async function deploy(
  ssh: SshExec,
  bundle: Buffer,
  options?: { timeoutMs?: number },
): Promise<void> {
  const result = await ssh(REMOTE_DEPLOY_COMMAND, {
    stdin: bundle,
    timeoutMs: options?.timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(
      `failed to deploy the RTS bundle to ${REMOTE_RTS_PATH} (ssh exit ${String(result.code)}): ${result.stderr.trim()}`,
    );
  }
}

/** Upload the prebuilt RTS binary to {@link REMOTE_RTS_BIN_PATH} (tmp + chmod + rename). */
export async function deployBin(
  ssh: SshExec,
  binary: Buffer,
  options?: { timeoutMs?: number },
): Promise<void> {
  const result = await ssh(REMOTE_BIN_DEPLOY_COMMAND, {
    stdin: binary,
    timeoutMs: options?.timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(
      `failed to deploy the RTS binary to ${REMOTE_RTS_BIN_PATH} (ssh exit ${String(result.code)}): ${result.stderr.trim()}`,
    );
  }
}

/**
 * Size-aware deploy timeout for the binary flavor: the ~100 MB upload needs
 * far more than the connect-sized budget on real links, so assume a
 * conservative 1 MB/s floor plus a 60 s margin — never below the base
 * (connect) timeout that already covers small uploads.
 */
export function deployTimeoutForBytes(bytes: number, baseTimeoutMs: number): number {
  return Math.max(baseTimeoutMs, Math.ceil(bytes / (1024 * 1024)) * 1000 + 60_000);
}

/**
 * Read the local deployable bundle. Resolution order:
 *
 * 1. `bundlePath` overrides the location (tests use it).
 * 2. dist/rts.js of this package, resolved by walking up from this file to
 *    the package root — the repo dev flow and the built package. Winning
 *    over the embedded copy keeps the file authoritative where it exists
 *    (it is always the freshest artifact of a local build).
 * 3. The RTS source embedded at build time (`#/generated/rts-bundle`) — the
 *    packaged-build fallback. Every downstream bundle (the npm CLI, the SEA
 *    binary) inlines that string from this package's source, so no
 *    dist/rts.js or `@moonshot-ai/remote-ssh` manifest has to exist on disk.
 */
export async function readLocalBundle(bundlePath?: string): Promise<Buffer> {
  if (bundlePath !== undefined) {
    return readBundleFile(bundlePath);
  }
  const path = findBundlePath();
  if (path !== null) {
    try {
      return await readFile(path);
    } catch (error) {
      // A missing default bundle (never built, or a packaged layout without
      // dist/rts.js) falls through to the embedded copy; other read
      // failures are real errors.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const embedded = await readEmbeddedBundle();
  if (embedded !== null) return embedded;
  throw new Error(
    `RTS bundle not found${path === null ? '' : ` at ${path}`} and no embedded bundle is available. ` +
      'Run `pnpm --filter @moonshot-ai/remote-ssh build` first (or pass the bundlePath option).',
  );
}

async function readBundleFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `RTS bundle not found at ${path}. Run \`pnpm --filter @moonshot-ai/remote-ssh build\` first (or pass the bundlePath option).`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * The RTS source embedded at build time (`src/generated/rts-bundle.ts`,
 * written by the rts-bundle-embed tsdown plugin). Null when unavailable:
 * on a fresh clone the import resolves to the empty `.d.ts` stub (or fails
 * outright), both treated as "no embedded bundle".
 */
async function readEmbeddedBundle(): Promise<Buffer | null> {
  try {
    const { RTS_BUNDLE_SOURCE } = await import('#/generated/rts-bundle');
    return Buffer.from(RTS_BUNDLE_SOURCE, 'utf8');
  } catch {
    return null;
  }
}

/** dist/rts.js of this package; null when no package root is found up-tree. */
function findBundlePath(): string | null {
  const root = findPackageRoot();
  return root === null ? null : join(root, 'dist', 'rts.js');
}

/**
 * Read the local prebuilt RTS binary for a remote platform. Resolution order:
 *
 * 1. `seaDir` overrides the artifact location (tests use it); no fallthrough.
 * 2. `sea/<platform>/rts-bin` of this package, resolved by walking up from
 *    this file to the package root — the repo dev flow (scripts/build-sea.mjs
 *    output). The binary is never embedded into downstream bundles (size) and
 *    is not published, so a packaged build finds nothing here.
 * 3. `sea/<platform>/rts-bin` under the kimi home (`KIMI_CODE_HOME` ??
 *    `~/.kimi-code`) — where packaged installs keep the artifacts.
 * 4. Null: the caller falls back to the script flavor.
 */
export async function readLocalSeaBinary(
  platform: RemotePlatformKey,
  seaDir?: string,
): Promise<Buffer | null> {
  const dirs = seaDir !== undefined ? [seaDir] : [findSeaDir(), kimiHomeSeaDir()];
  for (const dir of dirs) {
    if (dir === null) continue;
    const binary = await readSeaBinary(dir, platform);
    if (binary !== null) return binary;
  }
  return null;
}

/** `sea/<platform>/rts-bin` under `dir`; null when not present. */
async function readSeaBinary(dir: string, platform: RemotePlatformKey): Promise<Buffer | null> {
  try {
    return await readFile(join(dir, platform, 'rts-bin'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

/** sea/ of this package; null when no package root is found up-tree. */
function findSeaDir(): string | null {
  const root = findPackageRoot();
  return root === null ? null : join(root, 'sea');
}

/** sea/ under the kimi home — the packaged install's artifact location. */
function kimiHomeSeaDir(): string {
  const home = process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
  return join(home, 'sea');
}

/** This package's root (the directory holding its manifest); null up-tree. */
function findPackageRoot(): string | null {
  let dir = import.meta.dirname;
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf-8'));
        if ((parsed as { name?: unknown }).name === '@moonshot-ai/remote-ssh') {
          return dir;
        }
      } catch {
        // Unreadable manifest: keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}
