import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const GoBackInputSchema = z.object({}).strict();
export type GoBackInput = z.infer<typeof GoBackInputSchema>;

export interface IGoBackTool extends AgentTool<GoBackInput> {
  readonly _serviceBrand: undefined;
}
export const IGoBackTool = createDecorator<IGoBackTool>('goBackTool');
