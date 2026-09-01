import { posix } from 'node:path';

export function remoteSessionDir(homeDir: string, sessionId: string): string {
  return posix.join(homeDir, '.kimi-code', 'remote-sessions', sessionId);
}
