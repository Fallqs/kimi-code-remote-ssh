import {
  Disposable,
  IShadowRegistry,
  LifecycleScope,
  ScopeActivation,
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

export class ShadowAliasService extends Disposable implements IShadowAliasService {
  declare readonly _serviceBrand: undefined;

  constructor(@IShadowRegistry private readonly registry: IShadowRegistry) {
    super();
  }

  noteSwitch(payload: unknown): void {
    const ids = parseSwitchIds(payload);
    if (ids === undefined) return;
    if (ids.direction === 'enter') {
      this.registry.noteEnter(ids.fromSessionId, ids.toSessionId);
    } else {
      this.registry.noteExit(ids.fromSessionId);
    }
  }

  effectiveId(clientId: string): string {
    return this.registry.effectiveId(clientId);
  }

  presentedId(engineId: string): string {
    return this.registry.presentedId(engineId);
  }

  isShadowId(id: string): boolean {
    return this.registry.isShadowId(id);
  }

  isShadowed(id: string): boolean {
    return this.registry.isShadowed(id);
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
  const registry = accessor.get(IShadowRegistry);
  await registry.ready;
  await registry.whenTransitionSettled(clientId);
  return resumeSessionById(accessor, registry.effectiveId(clientId), opts);
}

export function getLiveSessionForClient(
  accessor: ServicesAccessor,
  clientId: string,
): ISessionScopeHandle | undefined {
  if (!isClientVisibleSessionId(accessor, clientId)) return undefined;
  return getLiveSessionById(accessor, shadowAlias(accessor).effectiveId(clientId));
}
