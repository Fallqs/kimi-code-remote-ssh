

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { GOTO_MODE_FLAG_ID } from './flags';
import { GotoModeService } from './gotoModeService';
import { IAgentGotoModeService } from './shadow';
import { IShadowSessionCoordinator } from './shadowCoordinator';
import { ShadowSessionCoordinatorService } from './shadowCoordinatorService';
import { IShadowRegistry, ShadowRegistryService } from './shadowRegistry';
import { IGoBackTool } from './tools/goback/goBack';
import { GoBackTool } from './tools/goback/goBackTool';
import { IGotoTool } from './tools/goto/goto';
import { GotoTool } from './tools/goto/gotoTool';

export function gotoToolWhen(accessor: ServicesAccessor): boolean {
  return (
    accessor.get(IFlagService).enabled(GOTO_MODE_FLAG_ID) &&
    accessor.get(IAgentScopeContext).agentId === MAIN_AGENT_ID
  );
}

export class ShadowFeature extends Feature {
  static override readonly name = 'shadow';

  constructor() {
    super();
    this.contributeService(
      LifecycleScope.App,
      IShadowSessionCoordinator,
      ShadowSessionCoordinatorService,
    );
    this.contributeService(LifecycleScope.App, IShadowRegistry, ShadowRegistryService);
    this.contributeAgentService(IAgentGotoModeService, GotoModeService);
    this.contributeTool(IGotoTool, GotoTool, {
      name: 'GOTO',
      domain: 'goto',
      when: gotoToolWhen,
    });
    this.contributeTool(IGoBackTool, GoBackTool, {
      name: 'GOBACK',
      domain: 'goto',
      when: gotoToolWhen,
    });
  }
}

registerFeature(ShadowFeature);
