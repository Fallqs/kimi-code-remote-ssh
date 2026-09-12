import { ref, type LiveRef } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { ShadowModeInjection } from './injection/shadowModeInjection';
import { IAgentShadowModeService, type ShadowStatus } from './shadow';
import {
  IShadowHostSupport,
  IShadowSessionCoordinator,
  SHADOW_OF_METADATA_KEY,
} from './shadowCoordinator';
import { IShadowRegistry, type ShadowTransitionDirection } from './shadowRegistry';

const SHADOW_MODE_FAILURE_REMINDER_VARIANT = 'shadow_mode';

export class AgentShadowModeService extends Service implements IAgentShadowModeService {
  declare readonly _serviceBrand: undefined;

  private pendingAction: 'enter' | 'exit' | undefined;
  private transitionKey: string | undefined;
  private admissionHold: IDisposable | undefined;

  constructor(
    @ISessionContext private readonly sessionCtx: ISessionContext,
    @ISessionMetadata private readonly sessionMeta: ISessionMetadata,
    @IEventBus private readonly eventBus: IEventBus,
    @IShadowSessionCoordinator private readonly coordinator: IShadowSessionCoordinator,
    @IAgentReminderService private readonly reminders: IAgentReminderService,
    @IAgentScopeContext private readonly agentCtx: IAgentScopeContext,
    @IAgentContextMemoryService context: IAgentContextMemoryService,
    @IAgentStateService states: IAgentStateService,
    @IShadowRegistry private readonly registry: IShadowRegistry,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @ref(IShadowHostSupport) private readonly hostSupportRef: LiveRef<IShadowHostSupport>,
  ) {
    super();

    if (this.agentCtx.agentId === MAIN_AGENT_ID) {
      this._register(new ShadowModeInjection(reminders, this, context, states));
    }
    this._register(
      this.eventBus.subscribe('turn.ended', () => {
        const action = this.pendingAction;
        if (action === undefined) return;
        this.pendingAction = undefined;
        void this.runPending(action).catch((error: unknown) => {
          if (this.transitionKey !== undefined) {
            this.registry.abortTransition(this.transitionKey);
            this.transitionKey = undefined;
          }
          this.releaseAdmissionHold();
          const message = error instanceof Error ? error.message : String(error);
          this.reminders.notify(`Shadow mode ${action} failed: ${message}`, {
            variant: SHADOW_MODE_FAILURE_REMINDER_VARIANT,
          });
        });
      }),
    );
  }

  async status(): Promise<ShadowStatus | null> {
    if (this.agentCtx.agentId !== MAIN_AGENT_ID) return null;
    const meta = await this.sessionMeta.read();
    const source = meta.custom?.[SHADOW_OF_METADATA_KEY];
    if (typeof source !== 'string') return null;
    return { workDir: this.sessionCtx.cwd, sourceSessionId: source };
  }

  hostSupported(): boolean {
    return this.hostSupportRef.current !== undefined;
  }

  requestEnter(): void {
    this.requireMainAgent();
    if (!this.hostSupported()) {
      throw new Error2(
        ErrorCodes.SESSION_SHADOW_INVALID,
        'Shadow mode is not supported by this host',
      );
    }
    this.armPending('enter');
    this.armTransition(this.sessionCtx.sessionId, 'enter');
  }

  async requestExit(): Promise<void> {
    this.requireMainAgent();
    const status = await this.status();
    if (status === null) {
      throw new Error2(
        ErrorCodes.SESSION_SHADOW_INVALID,
        'Shadow mode exit requested outside a shadow session',
      );
    }
    this.armPending('exit');
    this.armTransition(status.sourceSessionId, 'exit');
  }

  releaseAdmissionHold(): void {
    const hold = this.admissionHold;
    this.admissionHold = undefined;
    this.transitionKey = undefined;
    hold?.dispose();
  }

  private armTransition(sourceSessionId: string, direction: ShadowTransitionDirection): void {
    try {
      this.registry.beginTransition(sourceSessionId, direction);
      this.admissionHold = this.loop.acquireAdmissionHold();
      this.transitionKey = sourceSessionId;
    } catch (error) {
      this.pendingAction = undefined;
      this.registry.abortTransition(sourceSessionId);
      this.releaseAdmissionHold();
      throw error;
    }
  }

  private requireMainAgent(): void {
    if (this.agentCtx.agentId !== MAIN_AGENT_ID) {
      throw new Error2(
        ErrorCodes.SESSION_SHADOW_INVALID,
        'Shadow mode is only available to the main agent',
      );
    }
  }

  private armPending(action: 'enter' | 'exit'): void {
    if (this.pendingAction !== undefined) {
      throw new Error2(
        ErrorCodes.SESSION_SHADOW_INVALID,
        'A shadow mode switch is already pending',
      );
    }
    this.pendingAction = action;
  }

  private async runPending(action: 'enter' | 'exit'): Promise<void> {
    if (action === 'enter') {
      await this.coordinator.enterShadow(this.sessionCtx.sessionId);
      return;
    }
    await this.coordinator.exitShadow(this.sessionCtx.sessionId);
  }
}
