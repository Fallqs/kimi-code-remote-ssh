

import { z } from 'zod';

import { type IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const BASH_SECTION = 'bash';

export const BashConfigSchema = z.object({
  stateful: z.boolean().optional(),
});

export type BashConfig = z.infer<typeof BashConfigSchema>;

export function resolveBashConfig(config: IConfigService): BashConfig | undefined {
  return config.get<BashConfig | undefined>(BASH_SECTION);
}

registerConfigSection(BASH_SECTION, BashConfigSchema);
