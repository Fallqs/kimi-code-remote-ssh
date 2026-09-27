import { IAgentGotoModeService } from '#/features/shadow/shadow';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { GotoInputSchema, IGotoTool, type GotoInput } from './goto';
import DESCRIPTION from './goto.md?raw';

export class GotoTool implements IGotoTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'GOTO' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GotoInputSchema);

  constructor(@IAgentGotoModeService private readonly gotoMode: IAgentGotoModeService) {}

  resolveExecution(args: GotoInput): ToolExecution {
    return {
      description: 'Entering GOTO target',
      approvalRule: this.name,
      execute: async () => {
        if (!this.gotoMode.hostSupported()) {
          return {
            isError: true,
            output: 'GOTO is not supported by this host.',
          };
        }
        const status = await this.gotoMode.status();
        if (status !== null) {
          return {
            isError: true,
            output: `Already in ${status.workDir}. Use GOBACK when the shadow work is done.`,
          };
        }

        let root: string;
        try {
          root = await this.gotoMode.requestEnter(args.path);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'GOTO failed.';
          return { isError: true, output: `GOTO failed: ${message}` };
        }

        return {
          output: [
            'GOTO requested. This turn ends now.',
            '',
            `At the turn boundary the session is forked into a session rooted at ${root} with the full conversation intact, and the host switches to it.`,
            'The current session is preserved untouched as the checkpoint. Do not call further tools in this turn.',
          ].join('\n'),
          stopTurn: true,
        };
      },
    };
  }
}
