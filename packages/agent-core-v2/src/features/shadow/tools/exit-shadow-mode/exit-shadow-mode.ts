

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const ExitShadowModeInputSchema = z.object({}).strict();
export type ExitShadowModeInput = z.infer<typeof ExitShadowModeInputSchema>;

export interface IExitShadowModeTool extends AgentTool<ExitShadowModeInput> {
  readonly _serviceBrand: undefined;
}
export const IExitShadowModeTool = createDecorator<IExitShadowModeTool>('exitShadowModeTool');
