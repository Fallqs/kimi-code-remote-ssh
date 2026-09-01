

import { createDecorator } from '#/_base/di/instantiation';

export interface ShadowStatus {

  readonly workDir: string;

  readonly sourceSessionId: string;
}

export interface IAgentShadowModeService {
  readonly _serviceBrand: undefined;

  status(): Promise<ShadowStatus | null>;

  hostSupported(): boolean;

  requestEnter(): void;

  requestExit(): void;
}

export const IAgentShadowModeService =
  createDecorator<IAgentShadowModeService>('agentShadowModeService');
