

import { createDecorator } from '#/_base/di/instantiation';

export interface ShadowStatus {

  readonly workDir: string;

  readonly sourceSessionId: string;
}

export interface IAgentGotoModeService {
  readonly _serviceBrand: undefined;

  status(): Promise<ShadowStatus | null>;

  hostSupported(): boolean;

  requestEnter(path?: string): Promise<string>;

  requestExit(): Promise<void>;

  releaseAdmissionHold(): void;
}

export const IAgentGotoModeService = createDecorator<IAgentGotoModeService>('gotoModeService');
