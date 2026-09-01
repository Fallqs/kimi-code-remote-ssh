

import { IAgentShadowModeService } from '#/features/shadow/shadow';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

import {
  ExitShadowModeInputSchema,
  IExitShadowModeTool,
  type ExitShadowModeInput,
} from './exit-shadow-mode';
import DESCRIPTION from './exit-shadow-mode.md?raw';

export class ExitShadowModeTool implements IExitShadowModeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ExitShadowMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ExitShadowModeInputSchema);

  constructor(@IAgentShadowModeService private readonly shadow: IAgentShadowModeService) {}

  resolveExecution(_args: ExitShadowModeInput): ToolExecution {
    return {
      description: 'Exiting shadow mode',
      approvalRule: this.name,
      execute: () => this.execution(),
    };
  }

  private async execution(): Promise<ExecutableToolResult> {
    const status = await this.shadow.status();
    if (status === null) {
      return {
        isError: true,
        output:
          'ExitShadowMode can only be called while shadow mode is active (inside a shadow session). Use EnterShadowMode first.',
      };
    }

    try {
      this.shadow.requestExit();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit shadow mode.';
      return { isError: true, output: `Failed to exit shadow mode: ${message}` };
    }

    return {
      output: [
        'Shadow mode exit requested. This turn ends now.',
        '',
        `At the turn boundary this shadow session's conversation rows since the fork are merged back into the original session (${status.sourceSessionId}), this shadow session is discarded — its local shell state and background tasks are destroyed — and the host switches back to the original session, restoring the checkpointed environment.`,
        'Files written under the shadow workdir persist on the local machine. Do not call further tools in this turn.',
      ].join('\n'),
      stopTurn: true,
    };
  }
}
