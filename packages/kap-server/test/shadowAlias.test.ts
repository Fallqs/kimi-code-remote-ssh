import {
  ISessionManager,
  SHADOW_OF_METADATA_KEY,
  type ServicesAccessor,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import {
  IShadowAliasService,
  ShadowAliasService,
  getLiveSessionForClient,
  isClientVisibleSessionId,
} from '../src/shadowAlias';

class FakeEventBus {
  private handlers: Array<(e: { type: string }) => void> = [];
  subscribe(handler: (e: { type: string }) => void) {
    this.handlers.push(handler);
    return {
      dispose: () => {
        const i = this.handlers.indexOf(handler);
        if (i >= 0) this.handlers.splice(i, 1);
      },
    };
  }
  emit(e: { type: string }): void {
    for (const h of [...this.handlers]) h(e);
  }
}

const EMPTY_INDEX = {
  listRecent: async () => ({ items: [], nextCursor: undefined }),
};

function makeAlias(
  eventBus = new FakeEventBus(),
  index: unknown = EMPTY_INDEX,
): { alias: ShadowAliasService; eventBus: FakeEventBus } {
  const alias = new ShadowAliasService(
    eventBus as unknown as ConstructorParameters<typeof ShadowAliasService>[0],
    index as ConstructorParameters<typeof ShadowAliasService>[1],
  );
  return { alias, eventBus };
}

const ENTER_S1 = {
  type: 'event.session.shadow_switched',
  fromSessionId: 's1',
  toSessionId: 'shadow-1',
  workspaceRoot: '/home/user/.kimi-code',
  direction: 'enter',
  agentId: 'main',
  sessionId: 's1',
};

const EXIT_S1 = {
  type: 'event.session.shadow_switched',
  fromSessionId: 'shadow-1',
  toSessionId: 's1',
  workspaceRoot: '/home/user/.kimi-code',
  direction: 'exit',
  agentId: 'main',
  sessionId: 's1',
};

function makeAccessor(
  alias: ShadowAliasService,
  opts: { liveIds?: readonly string[] } = {},
): ServicesAccessor {
  const liveIds = new Set(opts.liveIds ?? []);
  return {
    get(token: unknown): unknown {
      if (token === IShadowAliasService) return alias;
      if (token === ISessionManager) {
        return {
          get: (id: string) =>
            liveIds.has(id)
              ? { id, accessor: { get: () => undefined }, dispose: () => {} }
              : undefined,
        };
      }
      return undefined;
    },
  } as unknown as ServicesAccessor;
}

describe('ShadowAliasService', () => {
  it('is identity-mapped before any switch event', () => {
    const { alias } = makeAlias();
    expect(alias.effectiveId('s1')).toBe('s1');
    expect(alias.presentedId('s1')).toBe('s1');
    expect(alias.isShadowId('s1')).toBe(false);
    expect(alias.isShadowed('s1')).toBe(false);
  });

  it('folds enter/exit switch events from the event bus into both maps', () => {
    const { alias, eventBus } = makeAlias();

    eventBus.emit(ENTER_S1);
    expect(alias.isShadowed('s1')).toBe(true);
    expect(alias.isShadowId('shadow-1')).toBe(true);
    expect(alias.effectiveId('s1')).toBe('shadow-1');
    expect(alias.presentedId('shadow-1')).toBe('s1');
    expect(alias.effectiveId('other')).toBe('other');
    expect(alias.presentedId('other')).toBe('other');

    eventBus.emit(EXIT_S1);
    expect(alias.isShadowed('s1')).toBe(false);
    expect(alias.isShadowId('shadow-1')).toBe(false);
    expect(alias.effectiveId('s1')).toBe('s1');
    expect(alias.presentedId('shadow-1')).toBe('shadow-1');
  });

  it('noteSwitch is idempotent and ignores malformed payloads', () => {
    const { alias } = makeAlias();
    alias.noteSwitch(ENTER_S1);
    alias.noteSwitch(ENTER_S1);
    expect(alias.effectiveId('s1')).toBe('shadow-1');

    alias.noteSwitch(undefined);
    alias.noteSwitch({ direction: 'sideways', fromSessionId: 1, toSessionId: null });
    alias.noteSwitch({ direction: 'enter', fromSessionId: 'x' });
    expect(alias.effectiveId('s1')).toBe('shadow-1');
    expect(alias.isShadowed('x')).toBe(false);
  });

  it('walks chained shadows recursively and survives a cycle', () => {
    const { alias } = makeAlias();
    alias.noteSwitch(ENTER_S1);
    alias.noteSwitch({ ...ENTER_S1, fromSessionId: 'shadow-1', toSessionId: 'shadow-2' });
    expect(alias.effectiveId('s1')).toBe('shadow-2');
    expect(alias.presentedId('shadow-2')).toBe('s1');

    alias.noteSwitch({ ...ENTER_S1, fromSessionId: 'shadow-2', toSessionId: 's1' });
    expect(typeof alias.effectiveId('s1')).toBe('string');
    expect(typeof alias.presentedId('shadow-2')).toBe('string');
  });

  it('rebuilds the maps from the session index (restart mid-shadow)', async () => {
    const index = {
      listRecent: async ({ before }: { limit: number; before?: string }) => {
        if (before === undefined) {
          return {
            items: [
              { id: 'shadow-1', custom: { [SHADOW_OF_METADATA_KEY]: 's1' } },
              { id: 'plain', custom: {} },
            ],
            nextCursor: 'page-2',
          };
        }
        return {
          items: [{ id: 'shadow-2', custom: { [SHADOW_OF_METADATA_KEY]: 's2' } }],
          nextCursor: undefined,
        };
      },
    };
    const { alias } = makeAlias(new FakeEventBus(), index);

    await vi.waitFor(() => expect(alias.isShadowed('s1')).toBe(true));
    expect(alias.isShadowed('s2')).toBe(true);
    expect(alias.effectiveId('s1')).toBe('shadow-1');
    expect(alias.effectiveId('s2')).toBe('shadow-2');
    expect(alias.presentedId('shadow-2')).toBe('s2');
    expect(alias.isShadowId('plain')).toBe(false);
    expect(alias.isShadowed('plain')).toBe(false);
  });

  it('hides shadow ids and resolves the active shadow for client ids', () => {
    const { alias } = makeAlias();
    alias.noteSwitch(ENTER_S1);
    const accessor = makeAccessor(alias, { liveIds: ['s1', 'shadow-1'] });

    expect(isClientVisibleSessionId(accessor, 'shadow-1')).toBe(false);
    expect(isClientVisibleSessionId(accessor, 's1')).toBe(true);
    expect(getLiveSessionForClient(accessor, 'shadow-1')).toBeUndefined();
    expect(getLiveSessionForClient(accessor, 's1')?.id).toBe('shadow-1');

    alias.noteSwitch(EXIT_S1);
    expect(getLiveSessionForClient(accessor, 's1')?.id).toBe('s1');
  });
});
