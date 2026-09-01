/**
 * Parameter and result shapes of every `call` op, shared by the client and
 * the server. The wire itself is untyped JSON; this is the contract both
 * sides implement against.
 */

export interface RtsStat {
  stMode: number;
  stIno: number;
  stDev: number;
  stNlink: number;
  stUid: number;
  stGid: number;
  stSize: number;
  stAtime: number;
  stMtime: number;
  stCtime: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface RtsDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface FsReadTextParams {
  path: string;
  encoding?: BufferEncoding;
}

export interface FsReadTextResult {
  text: string;
}

export interface FsWriteTextParams {
  path: string;
  text: string;
  append?: boolean;
}

export interface FsReadBytesParams {
  path: string;
  maxBytes?: number;
}

export interface FsReadBytesResult {
  data: string;
}

export interface FsReadLinesParams {
  path: string;
}

export interface FsReadLinesResult {
  lines: string[];
}

export interface FsStatParams {
  path: string;
  followSymlinks?: boolean;
}

export interface FsStatResult {
  stat: RtsStat;
}

export interface FsReaddirParams {
  path: string;
}

export interface FsReaddirResult {
  entries: RtsDirEntry[];
}

export interface FsMkdirParams {
  path: string;
  recursive?: boolean;
}

export interface FsRemoveParams {
  path: string;
  recursive?: boolean;
}

export interface FsExistsParams {
  path: string;
}

export interface FsExistsResult {
  exists: boolean;
}

export interface FsRealpathParams {
  path: string;
}

export interface FsRealpathResult {
  path: string;
}

export interface FsGlobParams {
  path: string;
  pattern: string;
  caseSensitive?: boolean;
}

export interface FsGlobResult {
  matches: string[];
}

export interface ProcSpawnParams {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ProcSpawnResult {
  channel: number;
  /** Remote pid; the process runs in its own process group (`-pid`). */
  pid: number;
}

/** Result of ops that produce no payload. */
export type VoidResult = Record<string, never>;

export interface OpParams {
  'fs.readText': FsReadTextParams;
  'fs.writeText': FsWriteTextParams;
  'fs.readBytes': FsReadBytesParams;
  'fs.readLines': FsReadLinesParams;
  'fs.stat': FsStatParams;
  'fs.readdir': FsReaddirParams;
  'fs.mkdir': FsMkdirParams;
  'fs.remove': FsRemoveParams;
  'fs.exists': FsExistsParams;
  'fs.realpath': FsRealpathParams;
  'fs.glob': FsGlobParams;
  'proc.spawn': ProcSpawnParams;
}

export interface OpResults {
  'fs.readText': FsReadTextResult;
  'fs.writeText': VoidResult;
  'fs.readBytes': FsReadBytesResult;
  'fs.readLines': FsReadLinesResult;
  'fs.stat': FsStatResult;
  'fs.readdir': FsReaddirResult;
  'fs.mkdir': VoidResult;
  'fs.remove': VoidResult;
  'fs.exists': FsExistsResult;
  'fs.realpath': FsRealpathResult;
  'fs.glob': FsGlobResult;
  'proc.spawn': ProcSpawnResult;
}

export type OpName = keyof OpParams;
