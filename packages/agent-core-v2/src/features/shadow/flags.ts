

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const GOTO_MODE_FLAG_ID = 'goto_mode';
export const GOTO_MODE_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_GOTO_MODE';

export const gotoModeFlag: FlagDefinitionInput = {
  id: GOTO_MODE_FLAG_ID,
  title: 'GOTO mode (temporary local execution environment)',
  description:
    'Lets an agent bound to a remote (ssh://) workspace temporarily switch its execution environment to the local kimi home via GOTO/GOBACK, checkpointing and restoring the remote tool state.',
  env: GOTO_MODE_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(gotoModeFlag);
