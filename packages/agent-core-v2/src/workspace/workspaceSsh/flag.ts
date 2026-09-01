import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SSH_WORKDIR_FLAG_ID = 'ssh-workdir';
export const SSH_WORKDIR_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SSH_WORKDIR';

export const sshWorkdirFlag: FlagDefinitionInput = {
  id: SSH_WORKDIR_FLAG_ID,
  title: 'SSH remote workspaces',
  description:
    'Allow ssh://[user@]host[:port]/path workspace roots: file and process operations run on the remote host over SSH while session persistence stays local.',
  env: SSH_WORKDIR_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(sshWorkdirFlag);
