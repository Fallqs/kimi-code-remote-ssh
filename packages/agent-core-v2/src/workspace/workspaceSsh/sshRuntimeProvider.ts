import {
  SshPipeClient,
  canonicalizeSshWorkDirSpec,
  isSshWorkDirSpec,
  type SshPipeOptions,
} from '@moonshot-ai/remote-ssh';

import { IFlagService } from '#/app/flag/flag';
import { Error2, ErrorCodes } from '#/errors';
import type {
  RuntimeProviderAttachment,
  RuntimeProviderContext,
  RuntimeProviderFactory,
} from '#/runtime/runtimeProvider';
import type { RuntimeProviderHost, RuntimeUnitImports } from '#/runtime/runtimeUnitHost';

import { SSH_WORKDIR_FLAG_ID } from './flag';
import { SshRuntime } from './sshRuntime';

export class SshRuntimeProviderFactory implements RuntimeProviderFactory {
  readonly id = 'ssh';
  readonly imports: RuntimeUnitImports = {
    root: [IFlagService],
    imports: [],
    local: [],
  };

  constructor(private readonly options?: SshPipeOptions) {}

  async attach(
    context: RuntimeProviderContext,
    host: RuntimeProviderHost,
  ): Promise<RuntimeProviderAttachment> {
    if (!isSshWorkDirSpec(context.root)) return { dispose() {} };
    if (!host.get(IFlagService).enabled(SSH_WORKDIR_FLAG_ID)) {
      throw new Error2(
        ErrorCodes.WORKSPACE_SSH_DISABLED,
        `ssh workspace roots are experimental; enable the ${SSH_WORKDIR_FLAG_ID} flag to use ${context.root}`,
      );
    }
    const canonicalRoot = canonicalizeSshWorkDirSpec(context.root);
    let client: SshPipeClient;
    try {
      client = await SshPipeClient.connect(canonicalRoot, this.options);
    } catch (error) {
      throw new Error2(
        ErrorCodes.WORKSPACE_SSH_CONNECT_FAILED,
        `failed to open ssh workspace ${canonicalRoot}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
    const handle = host.registerRuntime(new SshRuntime(context.id, client));
    return { dispose: () => handle.remove() };
  }
}
