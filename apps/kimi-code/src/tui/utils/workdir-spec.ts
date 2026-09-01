/**
 * Resolve the optional `/new [path]` argument into the workdir for the next
 * session. Pure path/FS logic with no TUI-state dependency so it can be unit
 * tested directly.
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';

import { join, resolve } from 'pathe';

/** Result of resolving a `/new` workdir argument. */
export type NewSessionWorkDirResolution =
  /** Empty spec: keep the current workdir (the long-standing `/new` behavior). */
  | { readonly kind: 'current' }
  /** `ssh://...` spec: a remote workdir; the SDK canonicalizes it and connects. */
  | { readonly kind: 'ssh' }
  /** Existing local directory; `workDir` is the normalized absolute path. */
  | { readonly kind: 'local'; readonly workDir: string }
  /** Local path that does not exist or is not a directory. */
  | { readonly kind: 'error'; readonly message: string };

/** Whether a workdir spec refers to an SSH remote (`ssh://`, case-insensitive). */
export function isSshWorkDirSpec(spec: string): boolean {
  return /^ssh:\/\//i.test(spec);
}

/**
 * Workdir equality for the resume guards. Stored ssh session workdirs are
 * canonical `ssh://...` strings, so they compare verbatim — path resolution
 * would mangle them. Local paths keep the resolved-path comparison.
 */
export function sameWorkDir(a: string, b: string): boolean {
  if (isSshWorkDirSpec(a) || isSshWorkDirSpec(b)) return a === b;
  return resolve(a) === resolve(b);
}

export function resolveNewSessionWorkDir(
  spec: string | undefined,
  currentWorkDir: string,
): NewSessionWorkDirResolution {
  const input = spec?.trim() ?? '';
  if (input.length === 0) return { kind: 'current' };
  if (isSshWorkDirSpec(input)) return { kind: 'ssh' };

  const resolved = resolve(currentWorkDir, expandLeadingHome(input));
  try {
    if (!statSync(resolved).isDirectory()) {
      return { kind: 'error', message: `Not a directory: ${resolved}` };
    }
  } catch {
    return { kind: 'error', message: `Directory not found: ${resolved}` };
  }
  return { kind: 'local', workDir: resolved };
}

function expandLeadingHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2));
  return input;
}
