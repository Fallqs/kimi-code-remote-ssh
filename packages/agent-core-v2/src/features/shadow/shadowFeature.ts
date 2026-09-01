

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { SHADOW_MODE_FLAG_ID } from './flags';
import { IAgentShadowModeService } from './shadow';
import { IShadowSessionCoordinator } from './shadowCoordinator';
import { ShadowSessionCoordinatorService } from './shadowCoordinatorService';
import { AgentShadowModeService } from './shadowService';
import { IEnterShadowModeTool } from './tools/enter-shadow-mode/enter-shadow-mode';
import { EnterShadowModeTool } from './tools/enter-shadow-mode/enterShadowModeTool';
import { IExitShadowModeTool } from './tools/exit-shadow-mode/exit-shadow-mode';
import { ExitShadowModeTool } from './tools/exit-shadow-mode/exitShadowModeTool';

export function shadowToolWhen(accessor: ServicesAccessor): boolean {
  return (
    accessor.get(IFlagService).enabled(SHADOW_MODE_FLAG_ID) &&
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
    this.contributeAgentService(IAgentShadowModeService, AgentShadowModeService);
    this.contributeTool(IEnterShadowModeTool, EnterShadowModeTool, {
      name: 'EnterShadowMode',
      domain: 'shadow',
      when: shadowToolWhen,
    });
    this.contributeTool(IExitShadowModeTool, ExitShadowModeTool, {
      name: 'ExitShadowMode',
      domain: 'shadow',
      when: shadowToolWhen,
    });
  }
}

registerFeature(ShadowFeature);
