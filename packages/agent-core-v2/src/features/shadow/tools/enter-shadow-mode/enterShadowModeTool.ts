

import { IAgentShadowModeService } from '#/features/shadow/shadow';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import {
  EnterShadowModeInputSchema,
  IEnterShadowModeTool,
  type EnterShadowModeInput,
} from './enter-shadow-mode';
import DESCRIPTION from './enter-shadow-mode.md?raw';

export class EnterShadowModeTool implements IEnterShadowModeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'EnterShadowMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EnterShadowModeInputSchema);

  constructor(@IAgentShadowModeService private readonly shadow: IAgentShadowModeService) {}

  resolveExecution(_args: EnterShadowModeInput): ToolExecution {
    return {
      description: 'Entering shadow mode',
      approvalRule: this.name,
      execute: async () => {
        if (!this.shadow.hostSupported()) {
          return {
            isError: true,
            output: 'Shadow mode is not supported by this host.',
          };
        }
        const status = await this.shadow.status();
        if (status !== null) {
          return {
            isError: true,
            output: `Shadow mode is already active (workdir: ${status.workDir}). Use ExitShadowMode when the local work is done.`,
          };
        }

        try {
          this.shadow.requestEnter();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to enter shadow mode.';
          return { isError: true, output: `Failed to enter shadow mode: ${message}` };
        }

        return {
          output: [
            'Shadow mode requested. This turn ends now.',
            '',
            'At the turn boundary the session is forked into a LOCAL session rooted at the local kimi home (~/.kimi-code) with the full conversation intact, and the host switches to it.',
            'The current session is preserved untouched as the checkpoint. Do not call further tools in this turn.',
          ].join('\n'),
          stopTurn: true,
        };
      },
    };
  }
}
