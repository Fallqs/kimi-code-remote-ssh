import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const WorkspaceErrors = {
  codes: {
    WORKSPACE_NOT_FOUND: 'workspace.not_found',
    WORKSPACE_SSH_DISABLED: 'workspace.ssh_disabled',
    WORKSPACE_SSH_CONNECT_FAILED: 'workspace.ssh_connect_failed',
  },
  info: {
    'workspace.ssh_disabled': {
      title: 'SSH workspaces are experimental',
      retryable: false,
      public: true,
      action:
        'Enable the ssh-workdir experimental flag (KIMI_CODE_EXPERIMENTAL_SSH_WORKDIR) to use ssh:// workspace roots.',
    },
    'workspace.ssh_connect_failed': {
      title: 'Failed to connect to the remote host',
      retryable: true,
      public: true,
      action: 'Check the host, your ssh config, and that the remote path exists.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WorkspaceErrors);
