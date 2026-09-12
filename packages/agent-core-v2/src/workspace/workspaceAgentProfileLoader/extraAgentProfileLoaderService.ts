import { ILogService } from '#/_base/log/log';
import { discoverAgentFiles } from '#/workspace/workspaceAgentProfileLoader/internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from '#/workspace/workspaceAgentProfileLoader/internal/agentProfileLoader';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { profilesFromDiscovery } from './internal/agentProfileFromFile';
import { configuredAgentRoots } from '#/workspace/workspaceAgentProfileLoader/internal/agentRoots';
import {
  EXTRA_AGENT_DIRS_SECTION,
  type ExtraAgentDirsConfig,
} from '#/workspace/workspaceAgentProfileLoader/configSection';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostEnvironment, type HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import {
  workspaceHostPaths,
  type WorkspaceHostPaths,
} from '#/workspace/workspaceContext/workspaceHostPaths';

import { IExtraAgentProfileLoader } from './extraAgentProfileLoader';

export class ExtraAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IExtraAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'extra';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.extra;

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostEnvironment private readonly env: HostEnvironmentInfo,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IUserAgentProfileLoader private readonly user: IUserAgentProfileLoader,
    registry?: IAgentProfileRegistry,
  ) {
    super(log, registry);
    this._register(
      this.configService.onDidSectionChange((event) => {
        if (event.domain === EXTRA_AGENT_DIRS_SECTION) {
          void this.reload().catch((error) => {
            this.log.warn(`agent profile loader "extra" reload failed: ${String(error)}`);
          });
        }
      }),
    );
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  private get paths(): WorkspaceHostPaths {
    return workspaceHostPaths(this.workspace, this.bootstrap, this.env);
  }

  protected async load(): Promise<AgentProfileContribution> {
    await this.configService.ready;
    const dirs = this.configService.get<ExtraAgentDirsConfig>(EXTRA_AGENT_DIRS_SECTION) ?? [];
    return profilesFromDiscovery(
      await discoverAgentFiles(
        this.fs,
        await configuredAgentRoots(
          this.fs,
          dirs,
          this.paths.cwd,
          this.paths.osHomeDir,
          'extra',
          (message, error) => {
            this.log.warn(message, error);
          },
        ),
        (message) => this.log.warn(message),
      ),
      (context) => this.user.getDefaultProfile().renderSystemPrompt(context),
    );
  }
}

