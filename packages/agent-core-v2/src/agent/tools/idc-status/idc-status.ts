import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const IDC_STATUS_TOOL_NAME = 'idc_status';

export const IdcStatusInputSchema = z.object({}).strict();

export type IdcStatusInput = z.infer<typeof IdcStatusInputSchema>;

export interface IIdcStatusTool extends AgentTool<IdcStatusInput> { readonly _serviceBrand: undefined }
export const IIdcStatusTool = createDecorator<IIdcStatusTool>('idcStatusTool');
