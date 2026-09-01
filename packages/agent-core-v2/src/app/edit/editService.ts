import {
  buildEditMatchCandidates,
  type EditMatchCandidate,
  hasLineNumberPrefixes,
  NORMALIZATION_UNESCAPED_CR,
  unescapeVisibleCarriageReturns,
} from '#/_base/text/fileView';
import type { LineEndingStyle } from '#/_base/text/line-endings';

import type { TextModel } from './textModel';

export interface EditApplyInput {
  readonly path: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all: boolean;
}

export type EditApplyResult =
  | {
      readonly ok: true;
      readonly rawContent: string;
      readonly count: number;

      readonly normalizations: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

function notFoundMessage(input: EditApplyInput, lineEndingStyle: LineEndingStyle): string {
  let message = `old_string not found in ${input.path}, the file contents may be out of date. Please use the Read Tool to reload the content.
`;
  if (hasLineNumberPrefixes(input.old_string)) {
    message +=
      ' old_string appears to include Read line-number prefixes (`N\\t`). ' +
      'Drop the line-number prefix and tab, then retry — Edit never strips them automatically.';
  }
  if (input.old_string.includes('\\r') && lineEndingStyle !== 'mixed') {
    const style = lineEndingStyle === 'crlf' ? 'CRLF' : 'LF';
    message +=
      ` The file uses ${style} line endings; a literal \\r in old_string matches the two ` +
      'characters backslash + r, not a carriage return.';
  }
  return message;
}

function notUniqueMessage(path: string, count: number): string {
  return (
    `old_string is not unique in ${path} (found ${String(count)} occurrences). ` +
    'To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.'
  );
}

export class EditService {
  apply(model: TextModel, input: EditApplyInput): EditApplyResult {
    const candidates = buildEditMatchCandidates(input.old_string, model.lineEndingStyle);
    for (const candidate of candidates) {
      if (input.replace_all) {
        const { text, count } = model.replaceAll(
          candidate.text,
          this.newStringFor(candidate, input.new_string),
        );
        if (count === 0) continue;
        return {
          ok: true,
          rawContent: model.materialize(text),
          count,
          normalizations: candidate.normalizations,
        };
      }

      const count = model.countOccurrences(candidate.text);
      if (count === 0) continue;
      if (count > 1) return { ok: false, error: notUniqueMessage(input.path, count) };

      const text = model.replaceOnce(
        candidate.text,
        this.newStringFor(candidate, input.new_string),
      );
      return {
        ok: true,
        rawContent: model.materialize(text),
        count: 1,
        normalizations: candidate.normalizations,
      };
    }
    return { ok: false, error: notFoundMessage(input, model.lineEndingStyle) };
  }

  private newStringFor(candidate: EditMatchCandidate, newString: string): string {
    if (candidate.normalizations.includes(NORMALIZATION_UNESCAPED_CR)) {
      return unescapeVisibleCarriageReturns(newString);
    }
    return newString;
  }
}
