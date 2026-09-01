/**
 * EditTool — exact string replacement in a file.
 *
 * Replaces the first occurrence of `old_string` with `new_string` by
 * default. When `replace_all` is true, replaces all occurrences.
 * Errors when `old_string` is not found or not unique (when
 * `replace_all=false`). Path access policy is resolved before any
 * Kaos I/O.
 *
 * Matching is view-aware (see `./file-view`): the exact `old_string`
 * always wins; only after an exact miss does it try the deterministic
 * fallback candidates (`\r` unescaping for mixed line-ending files, one
 * trailing `\n` ignored), and a fallback hit is reported in the output.
 * Read line-number prefixes are never stripped — they only add a
 * diagnostic hint to the not-found error.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import { materializeModelText, toModelTextView } from './line-endings';
import {
  buildEditMatchCandidates,
  hasLineNumberPrefixes,
  isTextDecodeError,
  NORMALIZATION_UNESCAPED_CR,
  notReadableTextMessage,
  unescapeVisibleCarriageReturns,
} from './file-view';
import type { LineEndingStyle } from './line-endings';
import EDIT_DESCRIPTION from './edit.md?raw';

// `old_string` must be non-empty: the non-replace_all branch walks
// occurrences with `content.indexOf("", pos)`, which would loop forever
// on an empty search string.
export const EditInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute.',
    ),
  old_string: z
    .string()
    .min(1)
    .describe(
      'Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; where Read shows \\r (mixed endings), copy the shown \\r verbatim — it is unescaped automatically. One trailing \\n difference is tolerated.',
    ),
  new_string: z
    .string()
    .describe(
      'Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files.',
    ),
  replace_all: z
    .boolean()
    .optional()
    .describe('Set true only when every occurrence of old_string should be replaced.'),
});

export type EditInput = z.Infer<typeof EditInputSchema>;

function replaceOnceLiteral(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString);
  if (index === -1) return content;
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

function notFoundMessage(
  path: string,
  oldString: string,
  lineEndingStyle: LineEndingStyle,
): string {
  let message = `old_string not found in ${path}, the file contents may be out of date. Please use the Read Tool to reload the content.
`;
  if (hasLineNumberPrefixes(oldString)) {
    message +=
      ' old_string appears to include Read line-number prefixes (`N\\t`). ' +
      'Drop the line-number prefix and tab, then retry — Edit never strips them automatically.';
  }
  if (oldString.includes('\\r') && lineEndingStyle !== 'mixed') {
    const style = lineEndingStyle === 'crlf' ? 'CRLF' : 'LF';
    message +=
      ` The file uses ${style} line endings; a literal \\r in old_string matches the two ` +
      'characters backslash + r, not a carriage return.';
  }
  return message;
}

export class EditTool implements BuiltinTool<EditInput> {
  readonly name = 'Edit' as const;
  readonly description = EDIT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EditInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {}

  resolveExecution(args: EditInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      kaos: this.kaos,
      workspace: this.workspace,
      operation: 'write',
    });
    return {
      accesses: ToolAccesses.readWriteFile(path),
      description: `Editing ${args.path}`,
      display: {
        kind: 'file_io',
        operation: 'edit',
        path,
        before: args.old_string,
        after: args.new_string,
      },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.kaos.pathClass(),
          homeDir: this.kaos.gethome(),
        }),
      execute: () => this.execution(args, path),
    };
  }

  private async execution(args: EditInput, safePath: string): Promise<ExecutableToolResult> {
    if (args.old_string === args.new_string) {
      return {
        isError: true,
        output: 'No changes to make: old_string and new_string are exactly the same.',
      };
    }

    try {
      const raw = await this.kaos.readText(safePath);
      if (raw.includes('\u0000')) {
        return { isError: true, output: notReadableTextMessage(args.path) };
      }
      const modelView = toModelTextView(raw);
      const content = modelView.text;
      const replaceAll = args.replace_all ?? false;
      const candidates = buildEditMatchCandidates(args.old_string, modelView.lineEndingStyle);

      for (const candidate of candidates) {
        // new_string receives the same `\r` unescaping as the matched
        // old_string candidate; the trailing-`\n` fallback never touches it.
        const newString = candidate.normalizations.includes(NORMALIZATION_UNESCAPED_CR)
          ? unescapeVisibleCarriageReturns(args.new_string)
          : args.new_string;
        const report =
          candidate.normalizations.length > 0
            ? ` (matched after normalizing: ${candidate.normalizations.join('; ')})`
            : '';

        if (!replaceAll) {
          let count = 0;
          let pos = 0;
          while (pos < content.length) {
            const idx = content.indexOf(candidate.text, pos);
            if (idx === -1) break;
            count++;
            pos = idx + candidate.text.length;
          }

          if (count === 0) continue;
          if (count > 1) {
            return {
              isError: true,
              output:
                `old_string is not unique in ${args.path} (found ${String(count)} occurrences). ` +
                'To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.',
            };
          }

          const newContent = replaceOnceLiteral(content, candidate.text, newString);
          await this.kaos.writeText(
            safePath,
            materializeModelText(newContent, modelView.lineEndingStyle),
          );
          return { output: `Replaced 1 occurrence in ${args.path}${report}` };
        }

        const parts = content.split(candidate.text);
        const replacementCount = parts.length - 1;
        if (replacementCount === 0) continue;

        const newContent = parts.join(newString);
        await this.kaos.writeText(
          safePath,
          materializeModelText(newContent, modelView.lineEndingStyle),
        );
        return {
          output: `Replaced ${String(replacementCount)} occurrences in ${args.path}${report}`,
        };
      }

      return {
        isError: true,
        output: notFoundMessage(args.path, args.old_string, modelView.lineEndingStyle),
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'EISDIR') {
        return { isError: true, output: `${args.path} is not a file.` };
      }
      if (isTextDecodeError(error)) {
        return { isError: true, output: notReadableTextMessage(args.path) };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
