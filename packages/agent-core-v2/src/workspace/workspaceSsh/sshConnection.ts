import type { SshPipeClient, SshPipeState } from '@moonshot-ai/remote-ssh';

export type { SshPipeState } from '@moonshot-ai/remote-ssh';

export interface IWorkspaceSshConnection {
  state(): SshPipeState;
  resume(): Promise<void>;
  onStateChange(listener: (state: SshPipeState) => void): () => void;
}

export class WorkspaceSshConnectionService implements IWorkspaceSshConnection {
  constructor(readonly client: SshPipeClient) {}

  state(): SshPipeState {
    return this.client.state;
  }

  async resume(): Promise<void> {
    if (this.client.state === 'ready') return;
    await this.client.resume();
  }

  onStateChange(listener: (state: SshPipeState) => void): () => void {
    return this.client.onStateChange((state) => {
      listener(state);
    });
  }
}
