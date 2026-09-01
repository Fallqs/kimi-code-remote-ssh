

import { unwrapErrorCause } from '#/_base/errors/errors';

import type { LineEndingStyle } from './line-endings';

export const NORMALIZATION_UNESCAPED_CR = 'unescaped \\r';

export const NORMALIZATION_TRAILING_LF = 'ignored trailing newline in old_string';

export interface EditMatchCandidate {
  readonly text: string;
  readonly normalizations: readonly string[];
}

const LINE_NUMBER_PREFIX = /^\d+\t/;

export function hasLineNumberPrefixes(text: string): boolean {
  return text.split('\n').every((line) => LINE_NUMBER_PREFIX.test(line));
}

export function unescapeVisibleCarriageReturns(text: string): string {
  return text.replaceAll('\\r', '\r');
}

function stripOneTrailingLf(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

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

export function notReadableTextMessage(path: string): string {
  return (
    `"${path}" is not readable as UTF-8 text. ` +
    'If it is an image or video, use ReadMediaFile. ' +
    'For other binary formats, use Bash or an MCP tool if available.'
  );
}

export function isTextDecodeError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return false;
  const code = (unwrapped as { code?: unknown })['code'];
  if (code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return true;
  if (!(unwrapped instanceof Error)) return false;
  return /encoded data was not valid|invalid.*encoding|invalid.*utf-?8/i.test(unwrapped.message);
}
