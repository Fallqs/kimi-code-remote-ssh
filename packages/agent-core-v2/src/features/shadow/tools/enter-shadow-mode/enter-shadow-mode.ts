

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const EnterShadowModeInputSchema = z.object({}).strict();
export type EnterShadowModeInput = z.infer<typeof EnterShadowModeInputSchema>;

export interface IEnterShadowModeTool extends AgentTool<EnterShadowModeInput> {
  readonly _serviceBrand: undefined;
}
export const IEnterShadowModeTool = createDecorator<IEnterShadowModeTool>('enterShadowModeTool');
