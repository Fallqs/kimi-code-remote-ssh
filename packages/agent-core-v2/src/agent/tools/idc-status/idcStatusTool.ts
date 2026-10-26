import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IDC_MAIN_AGENT_ONLY, mainAgentOnlyAvailable, mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';

import { IDC_STATUS_TOOL_NAME, IdcStatusInputSchema, IIdcStatusTool, type IdcStatusInput } from './idc-status';
import IDC_STATUS_DESCRIPTION from './idc-status.md?raw';

export class IdcStatusTool implements IIdcStatusTool {
  declare readonly _serviceBrand: undefined;
  readonly name = IDC_STATUS_TOOL_NAME;
  readonly description = IDC_STATUS_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(IdcStatusInputSchema);

  constructor(
    @IAgentFullCompactionService private readonly compaction: IAgentFullCompactionService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(_args: IdcStatusInput): ToolExecution {
    const denied = mainAgentOnlyExecution(this.scopeContext, IDC_MAIN_AGENT_ONLY);
    if (denied !== undefined) return denied;
    return {
      description: 'Reading idle auto-compaction settings',
      approvalRule: this.name,
      execute: async () => {
        const settings = this.compaction.idleCompactionSettings();
        return {
          output: `on: ${String(settings.on)}\nminutes: ${String(settings.minutes)}\nlower_bound: ${String(settings.lowerBound)}`,
          isError: false,
        };
      },
    };
  }
}

registerAgentToolService(IIdcStatusTool, IdcStatusTool, {
  name: IDC_STATUS_TOOL_NAME,
  domain: 'fullCompaction',
  when: mainAgentOnlyAvailable,
});
