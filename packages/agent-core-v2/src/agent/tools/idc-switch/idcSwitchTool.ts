import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IDC_MAIN_AGENT_ONLY, mainAgentOnlyAvailable, mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';

import { IDC_SWITCH_TOOL_NAME, IdcSwitchInputSchema, IIdcSwitchTool, type IdcSwitchInput } from './idc-switch';
import IDC_SWITCH_DESCRIPTION from './idc-switch.md?raw';

export class IdcSwitchTool implements IIdcSwitchTool {
  declare readonly _serviceBrand: undefined;
  readonly name = IDC_SWITCH_TOOL_NAME;
  readonly description = IDC_SWITCH_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(IdcSwitchInputSchema);

  constructor(
    @IAgentFullCompactionService private readonly compaction: IAgentFullCompactionService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: IdcSwitchInput): ToolExecution {
    const denied = mainAgentOnlyExecution(this.scopeContext, IDC_MAIN_AGENT_ONLY);
    if (denied !== undefined) return denied;
    const on = args.on ?? false;
    return {
      description: on ? 'Enabling idle auto-compaction' : 'Disabling idle auto-compaction',
      approvalRule: this.name,
      execute: async () => {
        try {
          const settings = this.compaction.configureIdleCompaction({
            on,
            minutes: args.minutes,
            lowerBound: args.lower_bound,
          });
          return {
            output: `on: ${String(settings.on)}\nminutes: ${String(settings.minutes)}\nlower_bound: ${String(settings.lowerBound)}`,
            isError: false,
          };
        } catch (error) {
          return { output: error instanceof Error ? error.message : String(error), isError: true };
        }
      },
    };
  }
}

registerAgentToolService(IIdcSwitchTool, IdcSwitchTool, {
  name: IDC_SWITCH_TOOL_NAME,
  domain: 'fullCompaction',
  when: mainAgentOnlyAvailable,
});
