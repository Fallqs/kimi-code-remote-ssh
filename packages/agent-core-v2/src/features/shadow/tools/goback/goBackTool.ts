import { IAgentGotoModeService } from '#/features/shadow/shadow';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

import { GoBackInputSchema, IGoBackTool, type GoBackInput } from './goBack';
import DESCRIPTION from './goBack.md?raw';

export class GoBackTool implements IGoBackTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'GOBACK' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GoBackInputSchema);

  constructor(@IAgentGotoModeService private readonly gotoMode: IAgentGotoModeService) {}

  resolveExecution(_args: GoBackInput): ToolExecution {
    return {
      description: 'Leaving the shadow target',
      approvalRule: this.name,
      execute: () => this.execution(),
    };
  }

  private async execution(): Promise<ExecutableToolResult> {
    const status = await this.gotoMode.status();
    if (status === null) {
      return {
        isError: true,
        output:
          'GOBACK can only be called while shadowed (inside a shadow session). Use GOTO first.',
      };
    }

    try {
      await this.gotoMode.requestExit();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GOBACK failed.';
      return { isError: true, output: `GOBACK failed: ${message}` };
    }

    return {
      output: [
        'GOBACK requested. This turn ends now.',
        '',
        `At the turn boundary this shadow session's conversation rows since the fork are merged back into the original session (${status.sourceSessionId}), this shadow session is discarded — its shell state and background tasks are destroyed — and the host switches back to the original session, restoring the checkpointed environment.`,
        'Files written under the shadow workdir persist in the shadow environment. Do not call further tools in this turn.',
      ].join('\n'),
      stopTurn: true,
    };
  }
}
