import { isAbsolute, join } from 'pathe';

import { canonicalizeSshWorkDirSpec, isSshWorkDirSpec } from '@moonshot-ai/remote-ssh';

import { Error2, ErrorCodes } from '#/errors';
import { SSH_WORKDIR_FLAG_ID } from '#/workspace/workspaceSsh/flag';

export interface ShadowTargetDeps {
  readonly homeDir: string;
  readonly osHomeDir: string;
  readonly sshEnabled: boolean;
}

export function resolveShadowTargetRoot(
  input: string | undefined,
  deps: ShadowTargetDeps,
): string {
  const trimmed = input?.trim();
  if (trimmed === undefined || trimmed === '') return deps.homeDir;
  if (isSshWorkDirSpec(trimmed)) {
    if (!deps.sshEnabled) {
      throw new Error2(
        ErrorCodes.WORKSPACE_SSH_DISABLED,
        `ssh shadow targets are experimental; enable the ${SSH_WORKDIR_FLAG_ID} flag to use ${trimmed}`,
      );
    }
    try {
      return canonicalizeSshWorkDirSpec(trimmed);
    } catch (error) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, `invalid ssh shadow target ${trimmed}`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
  const expanded =
    trimmed === '~'
      ? deps.osHomeDir
      : trimmed.startsWith('~/')
        ? join(deps.osHomeDir, trimmed.slice(2))
        : trimmed;
  if (!isAbsolute(expanded)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `shadow target path must be an absolute path or an ssh:// spec: ${trimmed}`,
    );
  }
  return expanded;
}

export function isShadowTargetRemote(root: string): boolean {
  return isSshWorkDirSpec(root);
}
