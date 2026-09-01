/**
 * Minimal OpenSSH client-config (`~/.ssh/config`) resolution: only the keys
 * a connection needs — `HostName`, `User`, `Port`. Everything else (keys,
 * proxies, `Match`, `Include`, ...) is left to the real `ssh` client, which
 * reads the same file when we exec it — this only works because the client
 * passes the host as typed (never the resolved `HostName`) as the ssh
 * destination, so `Host` stanzas still match.
 *
 * The resolver follows OpenSSH semantics: the file is scanned top to bottom
 * and, for each keyword, the FIRST value obtained from a matching `Host`
 * stanza wins (earlier stanzas beat later ones, and options before the first
 * `Host` line act as global defaults). Unknown keywords are ignored without
 * error.
 */

import { readFileSync } from 'node:fs';
import * as nodeOs from 'node:os';
import { join } from 'node:path';

/** The connection-relevant keys resolved for a host; all unset by default. */
export interface SshConnectionConfig {
  /** `HostName` value; undefined when no stanza sets it (use the alias). */
  readonly hostname?: string;
  readonly user?: string;
  readonly port?: number;
}

export interface ResolveSshConnectionOptions {
  /** Override the config file location (defaults to `~/.ssh/config`). */
  readonly configPath?: string;
}

// ── parser ─────────────────────────────────────────────────────────────

interface SshConfigEntry {
  /** Lowercased keyword. */
  readonly key: string;
  readonly value: string;
}

interface SshConfigSection {
  /** `undefined` for the global section before the first `Host` line. */
  readonly patterns: readonly string[] | undefined;
  readonly entries: SshConfigEntry[];
}

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Split a config line into keyword / value. Both `key value` (spaces or
 * tabs) and `key=value` separators are accepted, matching OpenSSH. Returns
 * `undefined` for blank lines, comments, and argument-less keywords.
 */
function parseConfigLine(line: string): SshConfigEntry | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return undefined;
  const match = /^(\S+?)(?:\s*=\s*|\s+)([\s\S]*)$/.exec(trimmed);
  if (match === null) return undefined;
  const key = (match[1] ?? '').toLowerCase();
  const value = stripSurroundingQuotes((match[2] ?? '').trim());
  if (key === '' || value === '') return undefined;
  return { key, value };
}

/** Parse ssh_config text into sections. */
export function parseSshConfig(text: string): SshConfigSection[] {
  const sections: SshConfigSection[] = [];
  // The global section is only materialized when it actually holds entries.
  let current: SshConfigSection = { patterns: undefined, entries: [] };

  for (const rawLine of text.split(/\r\n|[\n\r]/)) {
    const entry = parseConfigLine(rawLine);
    if (entry === undefined) continue;
    if (entry.key === 'host') {
      sections.push(current);
      // OpenSSH separates Host patterns with whitespace; accepting commas
      // too is a strict superset and matches common hand-written configs.
      const patterns = entry.value.split(/[\s,]+/).filter(p => p !== '');
      current = { patterns, entries: [] };
      continue;
    }
    current.entries.push(entry);
  }
  sections.push(current);

  return sections.filter(
    section => section.patterns !== undefined || section.entries.length > 0,
  );
}

// ── host pattern matching ──────────────────────────────────────────────

function wildcardToRegex(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else {
      source += char.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * OpenSSH Host-stanza matching: `*` / `?` wildcards, `!` negation. A
 * negated pattern that matches vetoes the whole stanza, regardless of any
 * other patterns on the line. Matching is case-SENSITIVE, like OpenSSH's
 * `match_pattern()` — `Host DEVBOX76` does not match a `devbox76` destination.
 */
function hostMatchesPatterns(patterns: readonly string[], host: string): boolean {
  let matched = false;
  for (const rawPattern of patterns) {
    const negated = rawPattern.startsWith('!');
    const pattern = negated ? rawPattern.slice(1) : rawPattern;
    if (pattern === '') continue;
    if (wildcardToRegex(pattern).test(host)) {
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
}

// ── resolver ───────────────────────────────────────────────────────────

function defaultSshConfigPath(): string {
  return join(nodeOs.homedir(), '.ssh', 'config');
}

function readConfigFile(configPath: string): string {
  try {
    return readFileSync(configPath, 'utf-8');
  } catch (error) {
    // A missing config file is a perfectly normal setup — treat as empty.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const port = Number.parseInt(value, 10);
  return port > 0 && port <= 65_535 ? port : undefined;
}

/**
 * Resolve the connection-relevant configuration for `host` from the OpenSSH
 * client config file. A missing file resolves to all-undefined (the caller
 * falls back to the alias as typed and ssh's own defaults). Spec-level
 * user/port override these values at the call site.
 */
export function resolveSshConnection(
  host: string,
  options?: ResolveSshConnectionOptions,
): SshConnectionConfig {
  const configPath = options?.configPath ?? defaultSshConfigPath();
  const sections = parseSshConfig(readConfigFile(configPath));

  let hostname: string | undefined;
  let user: string | undefined;
  let port: number | undefined;

  for (const section of sections) {
    if (section.patterns !== undefined && !hostMatchesPatterns(section.patterns, host)) {
      continue;
    }
    for (const entry of section.entries) {
      switch (entry.key) {
        case 'hostname':
          hostname ??= entry.value;
          break;
        case 'user':
          user ??= entry.value;
          break;
        case 'port':
          port ??= parsePort(entry.value);
          break;
        default:
          // Unknown / out-of-scope keywords are ignored by design.
          break;
      }
    }
  }

  return { hostname, user, port };
}
