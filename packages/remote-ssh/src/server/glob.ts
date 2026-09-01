import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Pure-JS recursive glob walk, ported from packages/kaos
 * (src/internal.ts `globPatternToRegex`, src/local.ts `_globWalk`) so that
 * remote globbing needs no `rg` on the remote host. Semantics mirror Python
 * pathlib: dotfiles included, case-sensitive by default, `**` matches zero
 * or more directories, and full joined paths are yielded.
 */

export function globPatternToRegex(pattern: string, caseSensitive: boolean): RegExp {
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === undefined) break;
    switch (ch) {
      case '*':
        regex += '[^/]*';
        break;
      case '?':
        regex += '[^/]';
        break;
      case '[': {
        const end = pattern.indexOf(']', i + 1);
        if (end === -1) {
          regex += '\\[';
        } else {
          // Glob character classes only use `!` for negation. A literal
          // leading `^` must remain literal even though JS regex char
          // classes treat it as negation in the first position.
          let charClass = pattern.slice(i + 1, end);
          // Escape backslashes inside the class so a trailing backslash
          // does not accidentally escape the closing `]`.
          charClass = charClass.replaceAll('\\', '\\\\');
          if (charClass.startsWith('!')) {
            charClass = '^' + charClass.slice(1);
          } else if (charClass.startsWith('^')) {
            charClass = '\\' + charClass;
          }
          regex += '[' + charClass + ']';
          i = end;
        }
        break;
      }
      case '\\': {
        if (i + 1 < pattern.length) {
          const next = pattern.charAt(i + 1);
          regex += next.replaceAll(/[{}()+.\\[\]^$|]/g, '\\$&');
          // Advance past the escaped character so it is not processed
          // again as a regex metacharacter. match literally.
          i++;
        } else {
          regex += '\\\\';
        }
        break;
      }
      default:
        regex += ch.replaceAll(/[{}()+.\\[\]^$|]/g, '\\$&');
    }
  }
  regex += '$';
  return new RegExp(regex, caseSensitive ? '' : 'i');
}

// `(stDev, stIno)` key of a directory for cycle detection. Node's
// `fs.Stats.ino` returns `0` on filesystems that don't carry inodes
// (Windows FAT/exFAT, some SMB/NFS mounts). A null key signals "no reliable
// identity for this dir" so the caller skips visited tracking for that
// descent — cycle safety is weakened on those filesystems, but normal
// walking works instead of every directory colliding on the shared key
// `"<dev>:0"`.
function cycleKey(s: { dev: number; ino: number }): string | null {
  if (s.ino === 0) return null;
  return `${String(s.dev)}:${String(s.ino)}`;
}

export async function* globWalk(
  basePath: string,
  pattern: string,
  caseSensitive: boolean,
): AsyncGenerator<string> {
  const patternParts = pattern.split('/');
  // Seed `visited` with basePath's own inode so that a symlink inside
  // basePath that points back at basePath is caught on its first
  // encounter (not on the second level — the "+1 depth" off-by-one
  // that would otherwise leak if the caller globs directly from the
  // loop root). `stat` failure here is tolerated: `walk` will hit the
  // same error via readdir and return empty.
  const initVisited = new Set<string>();
  try {
    const rootKey = cycleKey(await stat(basePath));
    if (rootKey !== null) initVisited.add(rootKey);
  } catch {
    // base does not exist / not accessible — walker handles via its own catch
  }
  yield* walk(basePath, patternParts, caseSensitive, initVisited);
}

// `visited` holds the `(stDev, stIno)` keys of directories on the
// current descent path. Before recursing into a subdirectory, we
// check its key against `visited`; if present we skip it (cycle
// detected) and otherwise recurse with a fresh Set containing the
// additional key. The per-recurse copy gives the check path-local
// semantics: two legitimate symlinks to the same target in separate
// branches both traverse, which is more permissive than Python stdlib
// while still cycle-safe.
// Same-directory self-recursion (e.g. `**` matching zero dirs with
// pattern tail) passes `visited` unchanged — no descent, no cycle
// risk.
async function* walk(
  basePath: string,
  patternParts: string[],
  caseSensitive: boolean,
  visited: Set<string>,
): AsyncGenerator<string> {
  if (patternParts.length === 0) {
    return;
  }

  const [currentPattern, ...remainingParts] = patternParts;

  if (currentPattern === '**') {
    // `**` matches zero or more directory components.
    //
    // There are exactly two cases to handle:
    //   (a) `**` matches zero directories → continue at basePath with the
    //       remaining pattern parts (or yield basePath itself when `**`
    //       is the final segment).
    //   (b) `**` matches one or more directories → recurse into each
    //       subdirectory, keeping `**` (i.e. the full patternParts) at
    //       the front. The "zero directories" case is then re-evaluated
    //       at the subdirectory level by that recursive call.
    //
    // We must NOT additionally recurse with `remainingParts` on
    // subdirectories — that would double-count every match at depth ≥ 1
    // because case (a) inside the child recursion already yields those
    // results.
    if (remainingParts.length > 0) {
      yield* walk(basePath, remainingParts, caseSensitive, visited);
    } else {
      // Pattern ends with `**`: yield basePath itself (zero-dir match).
      yield basePath;
    }

    let entries: string[];
    try {
      entries = await readdir(basePath);
    } catch {
      return;
    }

    for (const entry of entries) {
      // Use join to avoid "//entry" when basePath is a filesystem root.
      const fullPath = join(basePath, entry);
      let entryStat;
      try {
        entryStat = await stat(fullPath);
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        const key = cycleKey(entryStat);
        if (key !== null && visited.has(key)) continue;
        yield* walk(fullPath, patternParts, caseSensitive, key !== null ? new Set([...visited, key]) : visited);
      } else if (remainingParts.length === 0) {
        // Pattern ends with `**`: non-directory entries match too
        // (since `**` matches "anything").
        yield fullPath;
      }
    }
  } else {
    const regex = globPatternToRegex(currentPattern ?? '', caseSensitive);

    let entries: string[];
    try {
      entries = await readdir(basePath);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!regex.test(entry)) {
        continue;
      }

      // Use join to avoid "//entry" when basePath is a filesystem root.
      const fullPath = join(basePath, entry);

      if (remainingParts.length === 0) {
        yield fullPath;
      } else {
        let entryStat;
        try {
          entryStat = await stat(fullPath);
        } catch {
          continue;
        }
        if (entryStat.isDirectory()) {
          const key = cycleKey(entryStat);
          if (key !== null && visited.has(key)) continue;
          yield* walk(fullPath, remainingParts, caseSensitive, key !== null ? new Set([...visited, key]) : visited);
        }
      }
    }
  }
}
