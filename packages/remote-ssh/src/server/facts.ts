import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import type { RemoteFacts } from '#/protocol/frames';

const execFileAsync = promisify(execFile);

function osVersion(): string {
  try {
    return os.version();
  } catch {
    return os.release();
  }
}

/** Resolve bash's path through the shell itself (`command -v bash`). */
async function resolveShellPath(shell: string): Promise<string> {
  // The bare-name candidate covers environments where $SHELL is unset or
  // not directly executable but bash sits on PATH.
  for (const candidate of [shell, 'bash']) {
    try {
      const { stdout } = await execFileAsync(candidate, ['-c', 'command -v bash'], { timeout: 5_000 });
      const resolved = stdout.trim().split('\n')[0];
      if (resolved) return resolved;
    } catch {
      // Try the next candidate.
    }
  }
  return shell;
}

export async function probeFacts(): Promise<RemoteFacts> {
  const shell = process.env['SHELL'] ?? '/bin/bash';
  return {
    osKind: process.platform,
    osArch: process.arch,
    osVersion: osVersion(),
    shellName: 'bash',
    shellPath: await resolveShellPath(shell),
    pathClass: 'posix',
    homeDir: os.homedir(),
  };
}
