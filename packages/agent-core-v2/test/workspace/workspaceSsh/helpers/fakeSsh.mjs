#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
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

  const nodeMatch = /^node "([^"]+)"( --version)?$/.exec(remoteCommand);
  if (nodeMatch === null) {
    process.stderr.write(`fakeSsh: unsupported remote command: ${remoteCommand}\n`, () =>
      process.exit(2),
    );
    return;
  }

  const target = expandHome(nodeMatch[1]);
  const child = spawn(process.execPath, [target, ...(nodeMatch[2] !== undefined ? ['--version'] : [])], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

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
      for (const timer of pendingWrites) clearTimeout(timer);
      pendingWrites.clear();
      shutdown(code ?? 1);
    } else {
      setTimeout(() => shutdown(0), delayMs > 0 ? delayMs + 50 : 0);
    }
  });
}
