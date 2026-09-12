import { createControlledPromise } from '@antfu/utils';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';

import { SHADOW_ACTIVE_METADATA_KEY, SHADOW_OF_METADATA_KEY } from './shadowCoordinator';

export type ShadowTransitionDirection = 'enter' | 'exit';

export interface IShadowRegistry {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  effectiveId(clientId: string): string;

  presentedId(engineId: string): string;

  isShadowId(id: string): boolean;

  isShadowed(id: string): boolean;

  noteEnter(fromSessionId: string, toSessionId: string): void;

  noteExit(shadowSessionId: string): void;

  beginTransition(sourceSessionId: string, direction: ShadowTransitionDirection): void;

  settleTransition(sourceSessionId: string): void;

  abortTransition(sourceSessionId: string): void;

  whenTransitionSettled(sourceSessionId: string): Promise<void> | undefined;
}

export const IShadowRegistry = createDecorator<IShadowRegistry>('shadowRegistry');

const REBUILD_PAGE_LIMIT = 200;
const REBUILD_MAX_PAGES = 5;

interface PendingTransition {
  readonly direction: ShadowTransitionDirection;
  readonly settle: () => void;
  readonly promise: Promise<void>;
}

export class ShadowRegistryService extends Service implements IShadowRegistry {
  declare readonly _serviceBrand: undefined;

  private readonly shadowToMain = new Map<string, string>();
  private readonly mainToShadow = new Map<string, string>();
  private readonly transitions = new Map<string, PendingTransition>();

  readonly ready: Promise<void>;

  constructor(
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionManager sessions: ISessionManager,
  ) {
    super();
    if (sessions.onDidCloseSession !== undefined) {
      this._register(
        sessions.onDidCloseSession((closed) => {
          if (this.isShadowId(closed.sessionId)) this.noteExit(closed.sessionId);
        }),
      );
    }
    this.ready = this.rebuild().catch(() => undefined);
  }

  effectiveId(clientId: string): string {
    let id = clientId;
    const seen = new Set<string>([id]);
    for (;;) {
      const shadow = this.mainToShadow.get(id);
      if (shadow === undefined || seen.has(shadow)) return id;
      id = shadow;
      seen.add(id);
    }
  }

  presentedId(engineId: string): string {
    let id = engineId;
    const seen = new Set<string>([id]);
    for (;;) {
      const main = this.shadowToMain.get(id);
      if (main === undefined || seen.has(main)) return id;
      id = main;
      seen.add(id);
    }
  }

  isShadowId(id: string): boolean {
    return this.shadowToMain.has(id);
  }

  isShadowed(id: string): boolean {
    return this.mainToShadow.has(id);
  }

  noteEnter(fromSessionId: string, toSessionId: string): void {
    this.shadowToMain.set(toSessionId, fromSessionId);
    this.mainToShadow.set(fromSessionId, toSessionId);
  }

  noteExit(shadowSessionId: string): void {
    const main = this.shadowToMain.get(shadowSessionId);
    this.shadowToMain.delete(shadowSessionId);
    if (main !== undefined) this.mainToShadow.delete(main);
  }

  beginTransition(sourceSessionId: string, direction: ShadowTransitionDirection): void {
    if (this.transitions.has(sourceSessionId)) return;
    const controlled = createControlledPromise<void>();
    void controlled.catch(() => undefined);
    this.transitions.set(sourceSessionId, {
      direction,
      settle: controlled.resolve,
      promise: controlled,
    });
  }

  settleTransition(sourceSessionId: string): void {
    const transition = this.transitions.get(sourceSessionId);
    if (transition === undefined) return;
    this.transitions.delete(sourceSessionId);
    transition.settle();
  }

  abortTransition(sourceSessionId: string): void {
    this.settleTransition(sourceSessionId);
  }

  whenTransitionSettled(sourceSessionId: string): Promise<void> | undefined {
    return this.transitions.get(sourceSessionId)?.promise;
  }

  private async rebuild(): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < REBUILD_MAX_PAGES; page++) {
      const result = await this.index.listRecent({
        limit: REBUILD_PAGE_LIMIT,
        before: cursor,
      });
      for (const summary of result.items) {
        const shadowOf = summary.custom?.[SHADOW_OF_METADATA_KEY];
        const active = summary.custom?.[SHADOW_ACTIVE_METADATA_KEY];
        if (typeof shadowOf === 'string' && active === true) {
          this.shadowToMain.set(summary.id, shadowOf);
          this.mainToShadow.set(shadowOf, summary.id);
        }
      }
      if (result.nextCursor === undefined) return;
      cursor = result.nextCursor;
    }
  }
}

export function tryShadowRegistry(accessor: ServicesAccessor): IShadowRegistry | undefined {
  try {
    return accessor.get(IShadowRegistry) ?? undefined;
  } catch {
    return undefined;
  }
}
