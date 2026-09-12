import { join } from 'pathe';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';

import type { IWorkspaceContext } from './workspaceContext';

export interface WorkspaceHostPaths {
  readonly cwd: string;
  readonly homeDir: string;
  readonly osHomeDir: string;
}

export function workspaceHostPaths(
  workspace: Pick<IWorkspaceContext, 'cwd' | 'remoteCwd'>,
  bootstrap: Pick<IBootstrapService, 'homeDir' | 'osHomeDir'>,
  env: Pick<HostEnvironmentInfo, 'homeDir'>,
): WorkspaceHostPaths {
  if (workspace.remoteCwd === undefined) {
    return { cwd: workspace.cwd, homeDir: bootstrap.homeDir, osHomeDir: bootstrap.osHomeDir };
  }
  return {
    cwd: workspace.remoteCwd,
    homeDir: join(env.homeDir, '.kimi-code'),
    osHomeDir: env.homeDir,
  };
}
