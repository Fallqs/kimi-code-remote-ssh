import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const GotoInputSchema = z.object({ path: z.string().trim().min(1).optional() }).strict();
export type GotoInput = z.infer<typeof GotoInputSchema>;

export interface IGotoTool extends AgentTool<GotoInput> {
  readonly _serviceBrand: undefined;
}
export const IGotoTool = createDecorator<IGotoTool>('gotoTool');
