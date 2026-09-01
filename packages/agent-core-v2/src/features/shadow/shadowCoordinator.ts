/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { createDecorator } from '#/_base/di/instantiation';
import { Event2 } from '#/app/event/event2';

export const SHADOW_OF_METADATA_KEY = 'shadow_of';

export const SHADOW_FORK_POINT_METADATA_KEY = 'shadow_fork_message_count';

export const SHADOW_CREATED_WORKSPACE_METADATA_KEY = 'shadow_created_workspace';

export type ShadowSwitchDirection = 'enter' | 'exit';

export interface ShadowSwitchInfo {
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly workspaceRoot: string;
  readonly direction: ShadowSwitchDirection;
}

export interface SessionShadowSwitchedEvent extends ShadowSwitchInfo {
  readonly agentId: string;
  readonly sessionId: string;
}

export const SESSION_SHADOW_SWITCHED_EVENT = 'event.session.shadow_switched';

export class SessionShadowSwitched extends Event2<SessionShadowSwitchedEvent> {
  static override readonly type = SESSION_SHADOW_SWITCHED_EVENT;
}

export interface SessionShadowSwitched {
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly workspaceRoot: string;
  readonly direction: ShadowSwitchDirection;
  readonly agentId: string;
  readonly sessionId: string;
}

export interface IShadowSessionCoordinator {
  readonly _serviceBrand: undefined;

  enterShadow(sourceSessionId: string): Promise<ShadowSwitchInfo>;

  exitShadow(shadowSessionId: string): Promise<ShadowSwitchInfo>;
}

export const IShadowSessionCoordinator = createDecorator<IShadowSessionCoordinator>(
  'shadowSessionCoordinator',
);

export interface IShadowHostSupport {
  readonly _serviceBrand: undefined;
}

export const IShadowHostSupport = createDecorator<IShadowHostSupport>('shadowHostSupport');
