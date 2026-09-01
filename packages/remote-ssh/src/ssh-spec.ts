/**
 * SSH remote workdir specs: `ssh://[user@]host[:port]/abs/posix/path`.
 *
 * The host part may be a literal hostname or a `Host` alias from the user's
 * OpenSSH client config (`~/.ssh/config`) — alias resolution happens later,
 * in `resolveSshConnection`. The path is always an absolute POSIX path on
 * the remote host (no `~` expansion, no query/fragment).
 *
 * {@link canonicalizeSshWorkDirSpec} produces the identity string used for
 * session bucketing, metadata, and resume: scheme lowercased, host kept
 * verbatim (OpenSSH matches Host stanzas case-SENSITIVELY, so lowercasing
 * an alias like `DEVBOX76` would break the stanza match), the default port 22
 * elided, and the path posix-normalized without a trailing slash.
 */

import { posix } from 'node:path';

/** Malformed `ssh://` workdir spec input. */
export class RemoteSshValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteSshValueError';
  }
}

export interface SshWorkDirSpec {
  /** Hostname or `Host` alias, as written in the spec. */
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  /** Absolute posix path on the remote host, normalized (no trailing slash). */
  readonly path: string;
}

const SCHEME_RE = /^ssh:\/\//i;

/** Whether a workdir string is an `ssh://` remote spec (case-insensitive). */
export function isSshWorkDirSpec(spec: string): boolean {
  return SCHEME_RE.test(spec);
}

/**
 * Parse an `ssh://` workdir spec. Throws `RemoteSshValueError` with an
 * actionable message on malformed input.
 */
export function parseSshWorkDirSpec(spec: string): SshWorkDirSpec {
  if (!isSshWorkDirSpec(spec)) {
    throw new RemoteSshValueError(
      `Not an SSH workdir spec (expected ssh://[user@]host[:port]/path): ${spec}`,
    );
  }
  const rest = spec.replace(SCHEME_RE, '');
  if (rest.includes('?') || rest.includes('#')) {
    throw new RemoteSshValueError(`SSH workdir spec must not contain a query or fragment: ${spec}`);
  }
  const slashIndex = rest.indexOf('/');
  if (slashIndex < 0) {
    throw new RemoteSshValueError(
      `SSH workdir spec is missing an absolute remote path (e.g. ssh://host/dir): ${spec}`,
    );
  }
  const authority = rest.slice(0, slashIndex);
  const path = normalizeRemotePath(rest.slice(slashIndex));

  let user: string | undefined;
  let hostPort = authority;
  const atIndex = authority.lastIndexOf('@');
  if (atIndex >= 0) {
    user = authority.slice(0, atIndex);
    hostPort = authority.slice(atIndex + 1);
    if (user === '') {
      throw new RemoteSshValueError(`SSH workdir spec has an empty user: ${spec}`);
    }
  }

  let host = hostPort;
  let port: number | undefined;
  const colonIndex = hostPort.indexOf(':');
  if (colonIndex >= 0) {
    host = hostPort.slice(0, colonIndex);
    const portText = hostPort.slice(colonIndex + 1);
    if (portText.includes(':')) {
      throw new RemoteSshValueError(
        `SSH workdir specs do not support IPv6 literals; use a Host alias from ~/.ssh/config: ${spec}`,
      );
    }
    // An empty port segment (`ssh://host:/path`) is tolerated as "no port".
    if (portText !== '') {
      if (!/^\d+$/.test(portText)) {
        throw new RemoteSshValueError(`Invalid port in SSH workdir spec: ${spec}`);
      }
      port = Number.parseInt(portText, 10);
      if (port < 1 || port > 65_535) {
        throw new RemoteSshValueError(`Port out of range in SSH workdir spec: ${spec}`);
      }
    }
  }
  if (host === '') {
    throw new RemoteSshValueError(`SSH workdir spec has an empty host: ${spec}`);
  }

  return { host, user, port, path };
}

/**
 * Canonical identity string for an already-parsed spec: `ssh://` scheme
 * lowercase, host kept as written (Host-alias matching is case-sensitive),
 * default port 22 elided, path as normalized by the parser.
 */
export function formatSshWorkDirSpec(spec: SshWorkDirSpec): string {
  const userInfo = spec.user !== undefined ? `${spec.user}@` : '';
  const portSuffix = spec.port !== undefined && spec.port !== 22 ? `:${String(spec.port)}` : '';
  return `ssh://${userInfo}${spec.host}${portSuffix}${spec.path}`;
}

/**
 * Canonical identity string for an ssh workdir: `ssh://` scheme lowercase,
 * host kept as written, default port 22 elided, path posix-normalized.
 * Idempotent.
 */
export function canonicalizeSshWorkDirSpec(spec: string): string {
  return formatSshWorkDirSpec(parseSshWorkDirSpec(spec));
}

/** Posix-normalize an absolute remote path; strip trailing slashes except root. */
function normalizeRemotePath(path: string): string {
  const normalized = posix.normalize(path);
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  if (withLeadingSlash.length > 1) {
    const stripped = withLeadingSlash.replace(/\/+$/, '');
    return stripped === '' ? '/' : stripped;
  }
  return withLeadingSlash;
}
