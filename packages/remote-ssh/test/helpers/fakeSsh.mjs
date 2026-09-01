#!/usr/bin/env node
/**
 * Fake OpenSSH client for hermetic SshPipeClient tests (no real ssh, no
 * real HOME, no network). Spawned as `node fakeSsh.mjs <ssh argv...>` via
 * the client's `sshPath`/`sshArgs` injection; the LAST argv element is the
 * remote command string, everything before it is logged verbatim.
 *
 * Behavior (all against FAKE_SSH_HOME as the remote $HOME):
 * - `node --version`            → the local node version, or exit 127 when
 *                                 FAKE_SSH_NO_NODE=1 (remote node missing).
 * - `uname -sm`                 → FAKE_SSH_UNAME or 'Linux x86_64'.
 * - deploy (mkdir/cat/chmod/mv) → stores stdin bytes at the expanded target.
 * - `node "<rts>" --version`    → runs the REAL deployed bundle with
 *                                 --version, exit code passthrough.
 * - `node "<rts>"` (the pipe)   → runs the REAL deployed bundle and bridges
 *                                 stdio; FAKE_SSH_STDOUT_DELAY_MS delays
 *                                 server→client bytes (crash tests), and an
 *                                 abnormal child exit DROPS still-buffered
 *                                 bytes, like a dead remote kernel pipe.
 * - `"<rts-bin>" [--rts-version]` (binary flavor) → 127 when no rts-bin was
 *                                 deployed; otherwise the REAL bundle given
 *                                 by FAKE_SSH_RTS_BUNDLE stands in for the
 *                                 uploaded bytes (a dummy fixture that is
 *                                 never executed), bridging stdio the same
 *                                 way for the pipe form.
 *
 * Env: FAKE_SSH_HOME (required), FAKE_SSH_ARGV_LOG (append every argv as a
 * JSON line), FAKE_SSH_NO_NODE, FAKE_SSH_STDOUT_DELAY_MS, FAKE_SSH_UNAME,
 * FAKE_SSH_RTS_BUNDLE (required for the binary flavor).
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const home = process.env.FAKE_SSH_HOME;
if (home === undefined || home === '') {
  process.stderr.write('fakeSsh: FAKE_SSH_HOME is not set\n', () => process.exit(2));
} else {
  main(home);
}

function main(home) {
  const argv = process.argv.slice(2);
  const argvLog = process.env.FAKE_SSH_ARGV_LOG;
  if (argvLog !== undefined && argvLog !== '') {
    appendFileSync(argvLog, `${JSON.stringify(argv)}\n`);
  }
  const remoteCommand = argv.at(-1) ?? '';
  const delayMs = Number.parseInt(process.env.FAKE_SSH_STDOUT_DELAY_MS ?? '0', 10) || 0;
  const expandHome = path => path.replaceAll('$HOME', home);

  if (remoteCommand === 'node --version') {
    if (process.env.FAKE_SSH_NO_NODE === '1') {
      process.stderr.write('bash: line 1: node: command not found\n', () => process.exit(127));
    } else {
      process.stdout.write(`${process.version}\n`, () => process.exit(0));
    }
    return;
  }

  if (remoteCommand === 'uname -sm') {
    process.stdout.write(`${process.env.FAKE_SSH_UNAME ?? 'Linux x86_64'}\n`, () =>
      process.exit(0),
    );
    return;
  }

  const deployMatch = /cat > "([^"]+)"/.exec(remoteCommand);
  const moveMatch = /mv "[^"]+" "([^"]+)"/.exec(remoteCommand);
  if (remoteCommand.startsWith('mkdir -p ') && deployMatch !== null) {
    const target = expandHome(deployMatch[1]);
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
      try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.concat(chunks));
        if (moveMatch !== null) {
          renameSync(target, expandHome(moveMatch[1]));
        }
        process.exit(0);
      } catch (error) {
        process.stderr.write(`fakeSsh: deploy failed: ${String(error)}\n`, () => process.exit(1));
      }
    });
    process.stdin.resume();
    return;
  }

  const binMatch = /^"([^"]+)"( --rts-version)?$/.exec(remoteCommand);
  if (binMatch !== null) {
    const target = expandHome(binMatch[1]);
    if (!existsSync(target)) {
      process.stderr.write(`bash: line 1: ${binMatch[1]}: No such file or directory\n`, () =>
        process.exit(127),
      );
      return;
    }
    // The uploaded bytes are a dummy fixture that is never executed; the
    // real RTS bundle stands in for the deployed binary, version probe and
    // pipe alike.
    const rtsBundle = process.env.FAKE_SSH_RTS_BUNDLE;
    if (rtsBundle === undefined || rtsBundle === '') {
      process.stderr.write('fakeSsh: FAKE_SSH_RTS_BUNDLE is not set\n', () => process.exit(2));
      return;
    }
    bridgeStdio(
      spawn(process.execPath, [rtsBundle, ...(binMatch[2] !== undefined ? ['--rts-version'] : [])], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      delayMs,
    );
    return;
  }

  const nodeMatch = /^node "([^"]+)"( --version)?$/.exec(remoteCommand);
  if (nodeMatch === null) {
    process.stderr.write(`fakeSsh: unsupported remote command: ${remoteCommand}\n`, () =>
      process.exit(2),
    );
    return;
  }

  const target = expandHome(nodeMatch[1]);
  bridgeStdio(
    spawn(process.execPath, [target, ...(nodeMatch[2] !== undefined ? ['--version'] : [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    delayMs,
  );
}

/** Bridge the fake's stdio to the spawned RTS child (shared by both flavors). */
function bridgeStdio(child, delayMs) {
  const pendingWrites = new Set();
  let closed = false;
  const shutdown = code => {
    if (closed) return;
    closed = true;
    process.stdin.destroy();
    process.stdout.end();
    process.stderr.end();
    process.exitCode = code;
  };

  child.on('error', error => {
    process.stderr.write(`fakeSsh: failed to spawn remote node: ${error.message}\n`);
    shutdown(1);
  });
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {});
  child.stderr.pipe(process.stderr);
  child.stdout.on('data', chunk => {
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        pendingWrites.delete(timer);
        process.stdout.write(chunk);
      }, delayMs);
      pendingWrites.add(timer);
    } else {
      process.stdout.write(chunk);
    }
  });
  child.on('close', (code, signal) => {
    if (code !== 0 || signal !== null) {
      // A crashed remote never delivers bytes still sitting in the pipe.
      for (const timer of pendingWrites) clearTimeout(timer);
      pendingWrites.clear();
      shutdown(code ?? 1);
    } else {
      // Let delayed bytes flush before hanging up.
      setTimeout(() => shutdown(0), delayMs > 0 ? delayMs + 50 : 0);
    }
  });
}
