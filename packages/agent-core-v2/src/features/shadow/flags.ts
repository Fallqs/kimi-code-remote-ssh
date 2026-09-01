

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SHADOW_MODE_FLAG_ID = 'shadow_mode';
export const SHADOW_MODE_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SHADOW_MODE';

export const shadowModeFlag: FlagDefinitionInput = {
  id: SHADOW_MODE_FLAG_ID,
  title: 'Shadow mode (temporary local execution environment)',
  description:
    'Lets an agent bound to a remote (ssh://) workspace temporarily switch its execution environment to the local kimi home via EnterShadowMode/ExitShadowMode, checkpointing and restoring the remote tool state.',
  env: SHADOW_MODE_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(shadowModeFlag);
