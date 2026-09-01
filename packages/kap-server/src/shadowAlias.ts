import {
  Disposable,
  IEventService,
  ISessionIndex,
  LifecycleScope,
  ScopeActivation,
  SESSION_SHADOW_SWITCHED_EVENT,
  SHADOW_OF_METADATA_KEY,
  createDecorator,
  getLiveSessionById,
  registerScopedService,
  resumeSessionById,
  type ISessionScopeHandle,
  type ResumeSessionOptions,
  type ServicesAccessor,
} from '@moonshot-ai/agent-core-v2';

export interface IShadowAliasService {
  readonly _serviceBrand: undefined;

  effectiveId(clientId: string): string;
  presentedId(engineId: string): string;
  isShadowId(id: string): boolean;
  isShadowed(id: string): boolean;
  noteSwitch(payload: unknown): void;
}

export const IShadowAliasService = createDecorator<IShadowAliasService>('shadowAliasService');

interface SwitchIds {
  readonly direction: 'enter' | 'exit';
  readonly fromSessionId: string;
  readonly toSessionId: string;
}

function parseSwitchIds(payload: unknown): SwitchIds | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const { direction, fromSessionId, toSessionId } = record;
  if (direction !== 'enter' && direction !== 'exit') return undefined;
  if (typeof fromSessionId !== 'string' || typeof toSessionId !== 'string') return undefined;
  return { direction, fromSessionId, toSessionId };
}

const REBUILD_PAGE_LIMIT = 200;
const REBUILD_MAX_PAGES = 5;

export class ShadowAliasService extends Disposable implements IShadowAliasService {
  declare readonly _serviceBrand: undefined;

  private readonly shadowToMain = new Map<string, string>();
  private readonly mainToShadow = new Map<string, string>();

  constructor(
    @IEventService private readonly events: IEventService,
    @ISessionIndex private readonly index: ISessionIndex,
  ) {
    super();
    this._register(
      this.events.subscribe((event) => {
        if (event.type === SESSION_SHADOW_SWITCHED_EVENT) this.noteSwitch(event);
      }),
    );
    void this.rebuild().catch(() => {});
  }

  noteSwitch(payload: unknown): void {
    const ids = parseSwitchIds(payload);
    if (ids === undefined) return;
    if (ids.direction === 'enter') {
      this.shadowToMain.set(ids.toSessionId, ids.fromSessionId);
      this.mainToShadow.set(ids.fromSessionId, ids.toSessionId);
    } else {
      this.shadowToMain.delete(ids.fromSessionId);
      this.mainToShadow.delete(ids.toSessionId);
    }
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

  private async rebuild(): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < REBUILD_MAX_PAGES; page++) {
      const result = await this.index.listRecent({
        limit: REBUILD_PAGE_LIMIT,
        before: cursor,
      });
      for (const summary of result.items) {
        const shadowOf = summary.custom?.[SHADOW_OF_METADATA_KEY];
        if (typeof shadowOf === 'string') {
          this.shadowToMain.set(summary.id, shadowOf);
          this.mainToShadow.set(shadowOf, summary.id);
        }
      }
      if (result.nextCursor === undefined) return;
      cursor = result.nextCursor;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IShadowAliasService,
  ShadowAliasService,
  ScopeActivation.OnDemand,
  'shadow',
);

export function shadowAlias(accessor: ServicesAccessor): IShadowAliasService {
  return accessor.get(IShadowAliasService);
}

export function tryShadowAlias(accessor: ServicesAccessor): IShadowAliasService | undefined {
  try {
    return accessor.get(IShadowAliasService) ?? undefined;
  } catch {
    return undefined;
  }
}

export function isClientVisibleSessionId(accessor: ServicesAccessor, sessionId: string): boolean {
  return !shadowAlias(accessor).isShadowId(sessionId);
}

export async function resumeSessionForClient(
  accessor: ServicesAccessor,
  clientId: string,
  opts?: ResumeSessionOptions,
): Promise<ISessionScopeHandle | undefined> {
  if (!isClientVisibleSessionId(accessor, clientId)) return undefined;
  return resumeSessionById(accessor, shadowAlias(accessor).effectiveId(clientId), opts);
}

export function getLiveSessionForClient(
  accessor: ServicesAccessor,
  clientId: string,
): ISessionScopeHandle | undefined {
  if (!isClientVisibleSessionId(accessor, clientId)) return undefined;
  return getLiveSessionById(accessor, shadowAlias(accessor).effectiveId(clientId));
}
