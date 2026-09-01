/**
 * Wire contract of the Remote Tool Server (RTS) protocol.
 *
 * Framing is NDJSON: one JSON object per line, UTF-8, `\n`-terminated.
 * Binary payloads travel base64-encoded inside JSON strings.
 */

export const RTS_PROTOCOL = 1;
export const RTS_VERSION = '0.2.0';

/** Remote host facts probed by the server and sent in the hello frame. */
export interface RemoteFacts {
  osKind: string;
  osArch: string;
  osVersion: string;
  shellName: 'bash';
  shellPath: string;
  pathClass: 'posix';
  homeDir: string;
}

/** First frame on connect, server → client. */
export interface HelloFrame {
  type: 'hello';
  protocol: number;
  version: string;
  facts: RemoteFacts;
}

export interface CallFrame {
  type: 'call';
  id: number;
  op: string;
  params: Record<string, unknown>;
}

export interface OkFrame {
  type: 'ok';
  id: number;
  result: unknown;
}

export interface ErrFrame {
  type: 'err';
  id: number;
  code: string;
  message: string;
}

export interface ProcDataFrame {
  type: 'proc.data';
  channel: number;
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface ProcExitFrame {
  type: 'proc.exit';
  channel: number;
  code: number | null;
  signal: string | null;
}

export interface ProcStdinFrame {
  type: 'proc.stdin';
  channel: number;
  data: string;
}

export interface ProcStdinEofFrame {
  type: 'proc.stdin.eof';
  channel: number;
}

export interface ProcKillFrame {
  type: 'proc.kill';
  channel: number;
  signal?: string;
}

/** Frames the server may send. */
export type ServerFrame = HelloFrame | OkFrame | ErrFrame | ProcDataFrame | ProcExitFrame;

/** Frames the client may send. */
export type ClientFrame = CallFrame | ProcStdinFrame | ProcStdinEofFrame | ProcKillFrame;

export type Frame = ServerFrame | ClientFrame;
