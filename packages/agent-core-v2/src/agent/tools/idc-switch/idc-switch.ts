import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const IDC_SWITCH_TOOL_NAME = 'idc_switch';

export const IdcSwitchInputSchema = z.object({
  on: z.boolean().optional().default(false).describe('Whether idle auto-compaction is enabled. Defaults to false.'),
  minutes: z.number().positive().optional().describe('Idle delay in minutes. Defaults to the active model\'s idc_minutes.'),
  lower_bound: z.number().int().min(0).optional().describe('Minimum context tokens required for compaction. Defaults to loop_control.idc_lower_bound.'),
}).strict();

export type IdcSwitchInput = z.infer<typeof IdcSwitchInputSchema>;

export interface IIdcSwitchTool extends AgentTool<IdcSwitchInput> { readonly _serviceBrand: undefined }
export const IIdcSwitchTool = createDecorator<IIdcSwitchTool>('idcSwitchTool');
