/**
 * MRU store of session workdirs, persisted as a JSON array at
 * `<dataDir>/recent-workdirs.json`. Local absolute paths and canonical
 * `ssh://` specs are both stored verbatim; the `/new [path]` argument
 * completion reads them back as suggestions. All I/O is best-effort — a
 * missing or corrupt file reads as empty, and a failed write is dropped.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { getRecentWorkdirsFile } from '#/utils/paths';

/** Maximum number of entries kept; oldest drop off the end. */
const MAX_RECENT_WORKDIRS = 30;

/**
 * Load the stored workdirs, most-recent-first. Returns an empty list when the
 * file is missing, unreadable, or does not hold a JSON string array.
 */
export function loadRecentWorkdirs(): string[] {
  let text: string;
  try {
    text = readFileSync(getRecentWorkdirsFile(), 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
}

/**
 * Record a workdir as most recently used, deduping any earlier entry and
 * capping the list at 30. Write failures are swallowed so session flows
 * (create/resume) are never broken by the memory file.
 */
export function recordRecentWorkdir(workDir: string): void {
  const trimmed = workDir.trim();
  if (trimmed.length === 0) return;
  const next = [trimmed, ...loadRecentWorkdirs().filter((entry) => entry !== trimmed)];
  try {
    const file = getRecentWorkdirsFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next.slice(0, MAX_RECENT_WORKDIRS))}\n`, 'utf-8');
  } catch {
    /* best-effort only */
  }
}
