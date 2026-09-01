import {
  access,
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';

import type {
  FsExistsResult,
  FsGlobResult,
  FsReadBytesResult,
  FsReadLinesResult,
  FsReadTextResult,
  FsReaddirResult,
  FsRealpathResult,
  FsStatResult,
  VoidResult,
} from '#/protocol/ops';
import { globWalk } from '#/server/glob';
import {
  optionalBoolean,
  optionalEncoding,
  optionalNumber,
  requireAbsolutePath,
  requireString,
} from '#/server/validate';

export type OpHandler = (params: Record<string, unknown>) => Promise<unknown>;

async function fsReadText(params: Record<string, unknown>): Promise<FsReadTextResult> {
  const path = requireAbsolutePath(params, 'path');
  const encoding = optionalEncoding(params, 'encoding') ?? 'utf-8';
  const text = await readFile(path, { encoding });
  return { text };
}

async function fsWriteText(params: Record<string, unknown>): Promise<VoidResult> {
  const path = requireAbsolutePath(params, 'path');
  const text = requireString(params, 'text', { allowEmpty: true });
  const append = optionalBoolean(params, 'append') ?? false;
  // Parent directories are NOT created implicitly; a missing parent is ENOENT.
  if (append) {
    await appendFile(path, text, 'utf-8');
  } else {
    await writeFile(path, text, 'utf-8');
  }
  return {};
}

async function fsReadBytes(params: Record<string, unknown>): Promise<FsReadBytesResult> {
  const path = requireAbsolutePath(params, 'path');
  const maxBytes = optionalNumber(params, 'maxBytes');
  if (maxBytes === undefined) {
    const data = await readFile(path);
    return { data: data.toString('base64') };
  }
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return { data: buffer.subarray(0, bytesRead).toString('base64') };
  } finally {
    await handle.close();
  }
}

/** Split on LF / CRLF, without terminators; a trailing newline does not yield an empty final line. */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

async function fsReadLines(params: Record<string, unknown>): Promise<FsReadLinesResult> {
  const path = requireAbsolutePath(params, 'path');
  const text = await readFile(path, 'utf-8');
  return { lines: splitLines(text) };
}

async function fsStat(params: Record<string, unknown>): Promise<FsStatResult> {
  const path = requireAbsolutePath(params, 'path');
  const followSymlinks = optionalBoolean(params, 'followSymlinks') ?? true;
  // `isSymlink` always describes the link itself, so lstat is needed either
  // way; the second stat is skipped when there is no link to follow.
  const linkStat = await lstat(path);
  const isSymlink = linkStat.isSymbolicLink();
  const resolved = followSymlinks && isSymlink ? await stat(path) : linkStat;
  return {
    stat: {
      stMode: resolved.mode,
      stIno: resolved.ino,
      stDev: resolved.dev,
      stNlink: resolved.nlink,
      stUid: resolved.uid,
      stGid: resolved.gid,
      stSize: resolved.size,
      stAtime: resolved.atimeMs,
      stMtime: resolved.mtimeMs,
      stCtime: resolved.ctimeMs,
      isDirectory: resolved.isDirectory(),
      isFile: resolved.isFile(),
      isSymlink,
    },
  };
}

async function fsReaddir(params: Record<string, unknown>): Promise<FsReaddirResult> {
  const path = requireAbsolutePath(params, 'path');
  const dirents = await readdir(path, { withFileTypes: true });
  return {
    entries: dirents.map(dirent => ({
      name: dirent.name,
      isDirectory: dirent.isDirectory(),
      isFile: dirent.isFile(),
      isSymlink: dirent.isSymbolicLink(),
    })),
  };
}

async function fsMkdir(params: Record<string, unknown>): Promise<VoidResult> {
  const path = requireAbsolutePath(params, 'path');
  const recursive = optionalBoolean(params, 'recursive') ?? false;
  await mkdir(path, { recursive });
  return {};
}

async function fsRemove(params: Record<string, unknown>): Promise<VoidResult> {
  const path = requireAbsolutePath(params, 'path');
  const recursive = optionalBoolean(params, 'recursive') ?? false;
  // force: a missing path is success, mirroring `rm -f`.
  await rm(path, { recursive, force: true });
  return {};
}

async function fsExists(params: Record<string, unknown>): Promise<FsExistsResult> {
  const path = requireAbsolutePath(params, 'path');
  try {
    await access(path);
    return { exists: true };
  } catch {
    return { exists: false };
  }
}

async function fsRealpath(params: Record<string, unknown>): Promise<FsRealpathResult> {
  const path = requireAbsolutePath(params, 'path');
  return { path: await realpath(path) };
}

async function fsGlob(params: Record<string, unknown>): Promise<FsGlobResult> {
  const path = requireAbsolutePath(params, 'path');
  const pattern = requireString(params, 'pattern', { allowEmpty: true });
  const caseSensitive = optionalBoolean(params, 'caseSensitive') ?? true;
  const matches: string[] = [];
  for await (const match of globWalk(path, pattern, caseSensitive)) {
    matches.push(match);
  }
  return { matches };
}

export const OP_HANDLERS: Record<string, OpHandler> = {
  'fs.readText': fsReadText,
  'fs.writeText': fsWriteText,
  'fs.readBytes': fsReadBytes,
  'fs.readLines': fsReadLines,
  'fs.stat': fsStat,
  'fs.readdir': fsReaddir,
  'fs.mkdir': fsMkdir,
  'fs.remove': fsRemove,
  'fs.exists': fsExists,
  'fs.realpath': fsRealpath,
  'fs.glob': fsGlob,
};
