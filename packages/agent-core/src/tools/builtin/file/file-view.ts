/**
 * The Read/Edit shared "file view" contract.
 *
 * Read renders a raw file into a display view (line-number prefixes, pure
 * CRLF shown as LF, carriage returns in mixed files made visible as the
 * two-character `\r`). Edit consumes strings the model copied from that
 * view. This module owns the view-side helpers Edit needs to match those
 * strings back against the raw text, so the two tools cannot drift apart:
 *
 * - exact matching always wins; the candidates from
 *   {@link buildEditMatchCandidates} are only fallbacks after an exact miss;
 * - a literal `\r` is unescaped to a real carriage return only for mixed
 *   line-ending files (where Read shows it that way);
 * - one trailing `\n` may be ignored (Read's per-line view loses whether the
 *   file ends with a newline);
 * - Read line-number prefixes are NEVER stripped automatically — they are
 *   only detected ({@link hasLineNumberPrefixes}) so the caller can tell the
 *   model to drop them itself.
 */

import type { LineEndingStyle } from './line-endings';

/** Reported when an old_string candidate matched after `\r` unescaping. */
export const NORMALIZATION_UNESCAPED_CR = 'unescaped \\r';
/** Reported when an old_string candidate matched after dropping one trailing `\n`. */
export const NORMALIZATION_TRAILING_LF = 'ignored trailing newline in old_string';

export interface EditMatchCandidate {
  readonly text: string;
  readonly normalizations: readonly string[];
}

const LINE_NUMBER_PREFIX = /^\d+\t/;

/**
 * True when every line of `text` carries a Read line-number prefix (`N\t`).
 * Used for diagnostics only — Edit never strips the prefix on its own.
 */
export function hasLineNumberPrefixes(text: string): boolean {
  return text.split('\n').every((line) => LINE_NUMBER_PREFIX.test(line));
}

/** Inverse of `makeCarriageReturnsVisible`: the two-character `\r` becomes a real CR. */
export function unescapeVisibleCarriageReturns(text: string): string {
  return text.replaceAll('\\r', '\r');
}

function stripOneTrailingLf(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/**
 * Ordered, de-duplicated old_string candidates. The first entry is always
 * the raw string (exact match); fallbacks follow in fixed priority order:
 * `\r`-unescaped (mixed files only), trailing-`\n`-stripped, then both
 * combined. Empty candidates are dropped so `indexOf('')` can never match.
 */
export function buildEditMatchCandidates(
  oldString: string,
  lineEndingStyle: LineEndingStyle,
): EditMatchCandidate[] {
  const candidates: EditMatchCandidate[] = [{ text: oldString, normalizations: [] }];

  if (lineEndingStyle === 'mixed' && oldString.includes('\\r')) {
    candidates.push({
      text: unescapeVisibleCarriageReturns(oldString),
      normalizations: [NORMALIZATION_UNESCAPED_CR],
    });
  }

  // Iterate over a snapshot: strip variants are pushed during the loop.
  for (const base of candidates.slice()) {
    const stripped = stripOneTrailingLf(base.text);
    if (stripped === base.text) continue;
    candidates.push({
      text: stripped,
      normalizations: [...base.normalizations, NORMALIZATION_TRAILING_LF],
    });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate.text.length === 0 || seen.has(candidate.text)) return false;
    seen.add(candidate.text);
    return true;
  });
}

/**
 * The refusal wording Read and Edit share for files that are not UTF-8
 * text (binary, undecodable, or containing NUL bytes).
 */
export function notReadableTextMessage(path: string): string {
  return (
    `"${path}" is not readable as UTF-8 text. ` +
    'If it is an image or video, use ReadMediaFile. ' +
    'For other binary formats, use Bash or an MCP tool if available.'
  );
}

/** True for strict UTF-8 decode failures. */
export function isTextDecodeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown })['code'];
  if (code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return true;
  if (!(error instanceof Error)) return false;
  return /encoded data was not valid|invalid.*encoding|invalid.*utf-?8/i.test(error.message);
}
