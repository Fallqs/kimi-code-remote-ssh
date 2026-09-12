import type { IAgentScopeHandle, ISessionScopeHandle } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentStateService } from '#/agent/state/agentState';
import { turnKey, TurnPrompt } from '#/agent/loop/turnOps';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { Error2, ErrorCodes } from '#/errors';
import type { ContentPart } from '#/kosong/contract/message';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import type { ExternalSessionSource } from '#/workspace/sessionLifecycle/sessionLifecycle';

import {
  IShadowSessionCoordinator,
  SessionShadowSwitched,
  SHADOW_ACTIVE_METADATA_KEY,
  SHADOW_CREATED_WORKSPACE_METADATA_KEY,
  SHADOW_FORK_POINT_METADATA_KEY,
  SHADOW_OF_METADATA_KEY,
  type SessionShadowSwitchedEvent,
  type ShadowSwitchInfo,
} from './shadowCoordinator';
import { IAgentShadowModeService } from './shadow';
import { IShadowRegistry } from './shadowRegistry';

const SHADOW_ENTER_CONTINUATION =
  '[shadow mode] You are now in the shadow session: your execution environment is the LOCAL machine, rooted at the shadow workdir. The original session is preserved untouched as the checkpoint. Continue your task; call ExitShadowMode when the local work is done.';

const SHADOW_EXIT_CONTINUATION =
  '[shadow mode] Exited shadow mode: the shadow session’s rows were merged back above and the shadow session was discarded. Your execution environment is restored to the original workspace. Continue your task.';

export class ShadowSessionCoordinatorService extends Service implements IShadowSessionCoordinator {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceInstanceManager private readonly instances: IWorkspaceInstanceManager,
    @ISessionManager private readonly sessions: ISessionManager,
    @ISessionIndex private readonly index: ISessionIndex,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IEventService private readonly events: IEventService,
    @IWorkspaceService private readonly catalog: IWorkspaceService,
    @IShadowRegistry private readonly registry: IShadowRegistry,
  ) {
    super();
  }

  private async sourceFor(sessionId: string): Promise<ExternalSessionSource | undefined> {
    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    const workspace = await this.instances.getOrCreate({
      workspaceId: summary.workspaceId,
      root: summary.cwd,
    });
    return {
      sessionId,
      handlerScope: workspace.context.persistenceScope,
      handle: this.sessions.get(sessionId),
    };
  }

  async enterShadow(sourceSessionId: string): Promise<ShadowSwitchInfo> {
    try {
      const source = await this.sourceFor(sourceSessionId);
      if (source === undefined) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sourceSessionId} does not exist`);
      }
      const sourceHandle = source.handle;
      const sourceMeta =
        sourceHandle !== undefined
          ? await sourceHandle.accessor.get(ISessionMetadata).read()
          : undefined;

      const sourceMain = sourceHandle?.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
      const forkPoint = sourceMain?.accessor.get(IAgentContextMemoryService).get().length ?? 0;

      const workspaceRoot = this.bootstrap.homeDir;
      const homeCataloged = await this.isCataloged(workspaceRoot);
      const metadata: Record<string, unknown> = {
        [SHADOW_OF_METADATA_KEY]: sourceSessionId,
        [SHADOW_FORK_POINT_METADATA_KEY]: forkPoint,
        [SHADOW_ACTIVE_METADATA_KEY]: true,
      };
      if (!homeCataloged) metadata[SHADOW_CREATED_WORKSPACE_METADATA_KEY] = true;
      const target = await this.sessions.forkFrom(workspaceRoot, source, {
        title: `Shadow: ${sourceMeta?.title ?? sourceSessionId}`,
        metadata,
        admissionHeldAgentIds: [MAIN_AGENT_ID],
      });
      const targetSessionId = target.accessor.get(ISessionContext).sessionId;
      this.registry.noteEnter(sourceSessionId, targetSessionId);

      this.enqueueContinuation(target, MAIN_AGENT_ID, SHADOW_ENTER_CONTINUATION);
      this.registry.settleTransition(sourceSessionId);
      const info: ShadowSwitchInfo = {
        fromSessionId: sourceSessionId,
        toSessionId: targetSessionId,
        workspaceRoot,
        direction: 'enter',
      };
      this.publishSwitch(info, sourceSessionId);
      return info;
    } catch (error) {
      this.registry.abortTransition(sourceSessionId);
      throw error;
    }
  }

  async exitShadow(shadowSessionId: string): Promise<ShadowSwitchInfo> {
    let sourceSessionId: string | undefined;
    try {
      const shadowHandle =
        this.sessions.get(shadowSessionId) ?? (await this.sessions.resume(shadowSessionId));
      if (shadowHandle === undefined || shadowHandle === null) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${shadowSessionId} does not exist`);
      }
      const meta = await shadowHandle.accessor.get(ISessionMetadata).read();
      sourceSessionId = meta.custom?.[SHADOW_OF_METADATA_KEY] as string | undefined;
      if (typeof sourceSessionId !== 'string') {
        throw new Error2(
          ErrorCodes.SESSION_SHADOW_INVALID,
          `session ${shadowSessionId} is not a shadow session`,
        );
      }
      const forkPoint = meta.custom?.[SHADOW_FORK_POINT_METADATA_KEY];
      const boundary = typeof forkPoint === 'number' && forkPoint >= 0 ? forkPoint : 0;

      const clearedCustom = { ...meta.custom };
      delete clearedCustom[SHADOW_ACTIVE_METADATA_KEY];
      await shadowHandle.accessor.get(ISessionMetadata).update(
        { custom: clearedCustom },
        { touchUpdatedAt: false },
      );

      const shadowMain = shadowHandle.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
      const rows = (shadowMain?.accessor.get(IAgentContextMemoryService).get() ?? []).slice(boundary);

      const sourceHandle = await this.sessions.resume(sourceSessionId);
      if (sourceHandle === undefined || sourceHandle === null) {
        throw new Error2(
          ErrorCodes.SESSION_NOT_FOUND,
          `shadow source session ${sourceSessionId} does not exist`,
        );
      }
      const sourceMain = sourceHandle.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
      if (sourceMain !== undefined) {
        if (shadowMain !== undefined) {
          await this.realignTurnClock(shadowMain, sourceMain);
        }
        if (rows.length > 0) {
          sourceMain.accessor.get(IAgentContextMemoryService).append(...rows);
        }
      }

      this.enqueueContinuation(sourceHandle, MAIN_AGENT_ID, SHADOW_EXIT_CONTINUATION);
      const workspaceRoot = this.bootstrap.homeDir;
      const info: ShadowSwitchInfo = {
        fromSessionId: shadowSessionId,
        toSessionId: sourceSessionId,
        workspaceRoot,
        direction: 'exit',
      };
      this.registry.noteExit(shadowSessionId);
      this.registry.settleTransition(sourceSessionId);
      this.publishSwitch(info, sourceSessionId);
      await this.sessions.delete(shadowSessionId);
      await this.removeShadowWorkspaceRow(meta.custom, workspaceRoot);
      sourceMain?.accessor.get(IAgentShadowModeService).releaseAdmissionHold();
      return info;
    } catch (error) {
      if (sourceSessionId !== undefined) this.registry.abortTransition(sourceSessionId);
      throw error;
    }
  }

  private async realignTurnClock(
    shadowMain: IAgentScopeHandle,
    sourceMain: IAgentScopeHandle,
  ): Promise<void> {
    try {
      const shadowStates = shadowMain.accessor.get(IAgentStateService);
      const sourceStates = sourceMain.accessor.get(IAgentStateService);
      if (!shadowStates.has(turnKey) || !sourceStates.has(turnKey)) return;
      const target = shadowStates.get(turnKey).nextTurnId;
      const shadowPrompts = await this.turnPromptRecords(shadowMain);
      const sourcePrompts = await this.turnPromptRecords(sourceMain);
      const dispatcher = sourceMain.accessor.get(IEventDispatcher);
      for (const record of shadowPrompts.slice(sourcePrompts.length)) {
        await dispatcher.dispatch(
          new TurnPrompt({
            agentId: MAIN_AGENT_ID,
            input: Array.isArray(record['input'])
              ? (record['input'] as readonly ContentPart[])
              : [],
            origin:
              typeof record['origin'] === 'object' && record['origin'] !== null
                ? (record['origin'] as PromptOrigin)
                : { kind: 'retry' },
            promptId: typeof record['promptId'] === 'string' ? record['promptId'] : undefined,
          }),
        );
      }
      while (sourceStates.get(turnKey).nextTurnId < target) {
        await dispatcher.dispatch(
          new TurnPrompt({ agentId: MAIN_AGENT_ID, input: [], origin: { kind: 'retry' } }),
        );
      }
    } catch {
    }
  }

  private async turnPromptRecords(agent: IAgentScopeHandle): Promise<WireRecord[]> {
    const records: WireRecord[] = [];
    for await (const record of agent.accessor.get(IWireService).readJournal()) {
      if (record.type === 'turn.prompt') records.push(record);
    }
    return records;
  }

  private async isCataloged(root: string): Promise<boolean> {
    const rootKey = workspaceRootKey(root);
    return (await this.catalog.list()).some((ws) => workspaceRootKey(ws.root) === rootKey);
  }

  private async removeShadowWorkspaceRow(
    custom: Record<string, unknown> | undefined,
    workspaceRoot: string,
  ): Promise<void> {
    if (custom?.[SHADOW_CREATED_WORKSPACE_METADATA_KEY] !== true) return;
    try {
      const rootKey = workspaceRootKey(workspaceRoot);
      const row = (await this.catalog.list()).find((ws) => workspaceRootKey(ws.root) === rootKey);
      if (row === undefined) return;
      if ((await this.index.count({ workspaceIds: [row.id] })) > 0) return;
      await this.catalog.delete(row.id);
    } catch {
    }
  }

  private enqueueContinuation(handle: ISessionScopeHandle, agentId: string, text: string): void {
    const agents = handle.accessor.get(IAgentLifecycleService);
    const agent = agents.handleOf(agentId);
    if (agent === undefined) return;
    void agent.accessor
      .get(IAgentPromptService)
      .enqueue({
        message: {
          role: 'user',
          content: [{ type: 'text', text }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      })
      .catch(() => {});
  }

  private publishSwitch(info: ShadowSwitchInfo, anchorSessionId: string): void {
    const payload: SessionShadowSwitchedEvent = {
      ...info,
      agentId: MAIN_AGENT_ID,
      sessionId: anchorSessionId,
    };
    this.events.publish(new SessionShadowSwitched(payload));
  }
}
