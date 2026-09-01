import { posix } from 'node:path';

export function remoteSessionDir(homeDir: string, sessionId: string): string {
  return posix.join(homeDir, '.kimi-code', 'remote-sessions', sessionId);
}

export function remoteSessionAgentDir(homeDir: string, sessionId: string, agentId: string): string {
  return posix.join(remoteSessionDir(homeDir, sessionId), 'agents', agentId);
}
