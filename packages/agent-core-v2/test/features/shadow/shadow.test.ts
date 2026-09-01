import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { IEventBus } from '#/app/event/eventBus';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentShadowModeService } from '#/features/shadow/shadow';
import {
  IShadowHostSupport,
  IShadowSessionCoordinator,
  SHADOW_CREATED_WORKSPACE_METADATA_KEY,
  SHADOW_FORK_POINT_METADATA_KEY,
  SHADOW_OF_METADATA_KEY,
  SessionShadowSwitched,
} from '#/features/shadow/shadowCoordinator';
import { ShadowSessionCoordinatorService } from '#/features/shadow/shadowCoordinatorService';
import { AgentShadowModeService } from '#/features/shadow/shadowService';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

function sessionContextStub(sessionId: string, cwd: string): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId,
    workspaceId: 'wd_src',
    sessionDir: `/tmp/${sessionId}`,
    metaScope: `sessions/wd_src/${sessionId}`,
    cwd,
    remoteCwd: undefined,
    scope: (subKey?: string) =>
      `sessions/wd_src/${sessionId}${subKey === undefined ? '' : `/${subKey}`}`,
  } as unknown as ISessionContext;
}

function sessionMetadataStub(custom: Record<string, unknown> | undefined): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    read: () => Promise.resolve({ title: 't', custom }),
  } as unknown as ISessionMetadata;
}

function agentScopeContextStub(agentId: string): IAgentScopeContext {
  return {
    _serviceBrand: undefined,
    agentId,
    scope: () => '',
  } as unknown as IAgentScopeContext;
}

interface TurnEndedBus {
  readonly bus: IEventBus;
  fireTurnEnded(): void;
}

function turnEndedBus(): TurnEndedBus {
  const handlers: Array<(event: unknown) => void> = [];
  return {
    bus: {
      _serviceBrand: undefined,
      subscribe: (type: string, handler: (event: unknown) => void) => {
        if (type === 'turn.ended') handlers.push(handler);
        return { dispose: () => {} };
      },
      publish: () => {},
    } as unknown as IEventBus,
    fireTurnEnded: () => {
      for (const handler of handlers) {
        handler({ type: 'turn.ended', turnId: 1, reason: 'completed' });
      }
    },
  };
}

describe('AgentShadowModeService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let bus: TurnEndedBus;
  let coordinator: {
    enterShadow: ReturnType<typeof vi.fn>;
    exitShadow: ReturnType<typeof vi.fn>;
  };
  let notify: ReturnType<typeof vi.fn>;
  let registerInjection: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    bus = turnEndedBus();
    coordinator = {
      enterShadow: vi.fn(async () => ({})),
      exitShadow: vi.fn(async () => ({})),
    };
    notify = vi.fn();
    registerInjection = vi.fn(() => ({ dispose: () => {} }));

    ix.stub(ISessionContext, sessionContextStub('s1', '/home/user/.kimi-code'));
    ix.stub(IAgentScopeContext, agentScopeContextStub(MAIN_AGENT_ID));
    ix.stub(ISessionMetadata, sessionMetadataStub(undefined));
    ix.stub(IEventBus, bus.bus);
    ix.stub(IShadowSessionCoordinator, {
      _serviceBrand: undefined,
      ...coordinator,
    } as unknown as IShadowSessionCoordinator);
    ix.stub(IAgentReminderService, {
      _serviceBrand: undefined,
      notify,
      register: registerInjection,
      reconcileWhenIdle: async () => {},
    } as unknown as IAgentReminderService);
    ix.stub(IAgentContextMemoryService, {
      _serviceBrand: undefined,
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    ix.stub(IAgentStateService, {
      _serviceBrand: undefined,
      contributeState: () => {},
      get: () => false,
      set: () => {},
    } as unknown as IAgentStateService);
    ix.set(IAgentShadowModeService, new SyncDescriptor(AgentShadowModeService));
  });
  afterEach(() => disposables.dispose());

  it('reports null status outside a shadow session and the shadow workdir inside one', async () => {
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    expect(await svc.status()).toBeNull();

    ix.stub(ISessionMetadata, sessionMetadataStub({ [SHADOW_OF_METADATA_KEY]: 's0' }));
    const shadowed = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    expect(await shadowed.status()).toEqual({
      workDir: '/home/user/.kimi-code',
      sourceSessionId: 's0',
    });
  });

  it('is inert for subagents: no status, requests rejected, no injection', async () => {
    ix.stub(IAgentScopeContext, agentScopeContextStub('sub-1'));
    ix.stub(ISessionMetadata, sessionMetadataStub({ [SHADOW_OF_METADATA_KEY]: 's0' }));
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    expect(await svc.status()).toBeNull();
    expect(registerInjection).not.toHaveBeenCalled();
    expect(() => svc.requestEnter()).toThrowError(/main agent/);
    expect(() => svc.requestExit()).toThrowError(/main agent/);
  });

  it('refuses to enter when the host does not support shadow mode', () => {
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    expect(svc.hostSupported()).toBe(false);
    expect(() => svc.requestEnter()).toThrowError(/not supported/);
  });

  it('enters at the turn boundary once armed', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    expect(svc.hostSupported()).toBe(true);
    svc.requestEnter();
    expect(coordinator.enterShadow).not.toHaveBeenCalled();
    bus.fireTurnEnded();
    await vi.waitFor(() => expect(coordinator.enterShadow).toHaveBeenCalledWith('s1'));
  });

  it('exits at the turn boundary once armed', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    ix.stub(ISessionMetadata, sessionMetadataStub({ [SHADOW_OF_METADATA_KEY]: 's0' }));
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    svc.requestExit();
    bus.fireTurnEnded();
    await vi.waitFor(() => expect(coordinator.exitShadow).toHaveBeenCalledWith('s1'));
  });

  it('rejects a second pending request', () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    svc.requestEnter();
    expect(() => svc.requestEnter()).toThrowError(/already pending/);
  });

  it('surfaces a switch failure as a one-off reminder notification', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    coordinator.enterShadow.mockRejectedValue(new Error('boom'));
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    svc.requestEnter();
    bus.fireTurnEnded();
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Shadow mode enter failed: boom', {
        variant: 'shadow_mode',
      }),
    );
  });
});

interface FakeSessionHandleOpts {
  readonly sessionId: string;
  readonly custom?: Record<string, unknown>;
  readonly contextMessages: unknown[];
  readonly enqueue: ReturnType<typeof vi.fn>;
  readonly append: ReturnType<typeof vi.fn>;
}

function fakeSessionHandle(opts: FakeSessionHandleOpts) {
  const agentHandle = {
    accessor: {
      get: (token: unknown) => {
        if (token === IAgentContextMemoryService) {
          return { get: () => opts.contextMessages, append: opts.append };
        }
        if (token === IAgentPromptService) return { enqueue: opts.enqueue };
        return undefined;
      },
    },
  };
  return {
    accessor: {
      get: (token: unknown) => {
        if (token === ISessionMetadata) {
          return {
            read: async () => ({ title: `t-${opts.sessionId}`, custom: opts.custom }),
          };
        }
        if (token === ISessionContext) return { sessionId: opts.sessionId };
        if (token === IAgentLifecycleService) {
          return { handleOf: (id: string) => (id === MAIN_AGENT_ID ? agentHandle : undefined) };
        }
        return undefined;
      },
    },
    dispose: () => {},
  };
}

describe('ShadowSessionCoordinatorService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let publish: ReturnType<typeof vi.fn>;
  let forkFrom: ReturnType<typeof vi.fn>;
  let deleteSession: ReturnType<typeof vi.fn>;
  let catalogDelete: ReturnType<typeof vi.fn>;
  const live = new Map<string, ReturnType<typeof fakeSessionHandle>>();

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    publish = vi.fn();
    forkFrom = vi.fn();
    deleteSession = vi.fn(async () => {});
    catalogDelete = vi.fn(async () => {});
    live.clear();

    ix.stub(IWorkspaceInstanceManager, {
      _serviceBrand: undefined,
      getOrCreate: async (ref: { readonly workspaceId?: string; readonly root?: string }) => ({
        id: ref.workspaceId ?? 'wd_home',
        context: {
          persistenceScope: `sessions/${ref.workspaceId ?? 'wd_home'}`,
        },
      }),
    } as unknown as IWorkspaceInstanceManager);
    ix.stub(ISessionManager, {
      _serviceBrand: undefined,
      get: (id: string) => live.get(id),
      resume: async (id: string) => live.get(id),
      forkFrom,
      delete: deleteSession,
    } as unknown as ISessionManager);
    ix.stub(ISessionIndex, {
      _serviceBrand: undefined,
      get: async (id: string) =>
        live.has(id) ? { id, workspaceId: 'wd_src', cwd: '/src' } : undefined,
      count: async () => 0,
    } as unknown as ISessionIndex);
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      homeDir: '/home/user/.kimi-code',
    } as unknown as IBootstrapService);
    ix.stub(IEventService, {
      _serviceBrand: undefined,
      publish,
    } as unknown as IEventService);
    ix.stub(IWorkspaceService, {
      _serviceBrand: undefined,
      list: async () => [],
      delete: catalogDelete,
    } as unknown as IWorkspaceService);
  });
  afterEach(() => disposables.dispose());

  function coordinator(): ShadowSessionCoordinatorService {
    return ix.createInstance(new SyncDescriptor(ShadowSessionCoordinatorService));
  }

  it('enterShadow forks into the home workspace with provenance metadata and publishes the switch', async () => {
    const enqueue = vi.fn(async () => ({}));
    const source = fakeSessionHandle({
      sessionId: 's1',
      custom: undefined,
      contextMessages: [{}, {}, {}],
      enqueue,
      append: vi.fn(),
    });
    live.set('s1', source);
    forkFrom.mockImplementation(async (root: string, src: unknown, opts: unknown) => {
      const target = fakeSessionHandle({
        sessionId: 'shadow-1',
        custom: (opts as { metadata?: Record<string, unknown> }).metadata,
        contextMessages: [],
        enqueue,
        append: vi.fn(),
      });
      live.set('shadow-1', target);
      return target;
    });

    const info = await coordinator().enterShadow('s1');

    expect(forkFrom).toHaveBeenCalledOnce();
    const [root, src, opts] = forkFrom.mock.calls[0]!;
    expect(root).toBe('/home/user/.kimi-code');
    expect((src as { sessionId: string }).sessionId).toBe('s1');
    expect((src as { handlerScope: string }).handlerScope).toBe('sessions/wd_src');
    expect((opts as { metadata: Record<string, unknown> }).metadata).toEqual({
      [SHADOW_OF_METADATA_KEY]: 's1',
      [SHADOW_FORK_POINT_METADATA_KEY]: 3,
      [SHADOW_CREATED_WORKSPACE_METADATA_KEY]: true,
    });
    expect(info).toEqual({
      fromSessionId: 's1',
      toSessionId: 'shadow-1',
      workspaceRoot: '/home/user/.kimi-code',
      direction: 'enter',
    });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    const event = publish.mock.calls[0]![0] as SessionShadowSwitched;
    expect(event.type).toBe('event.session.shadow_switched');
    expect(event.sessionId).toBe('s1');
    expect(event.toSessionId).toBe('shadow-1');
  });

  it('exitShadow pads post-fork rows back, publishes, then deletes the shadow session', async () => {
    ix.stub(IWorkspaceService, {
      _serviceBrand: undefined,
      list: async () => [
        { id: 'wd_home', root: '/home/user/.kimi-code', name: 'home', createdAt: 0, lastOpenedAt: 0 },
      ],
      delete: catalogDelete,
    } as unknown as IWorkspaceService);
    const sourceAppend = vi.fn();
    const enqueue = vi.fn(async () => ({}));
    live.set(
      's1',
      fakeSessionHandle({
        sessionId: 's1',
        contextMessages: [{}, {}, {}],
        enqueue,
        append: sourceAppend,
      }),
    );
    live.set(
      'shadow-1',
      fakeSessionHandle({
        sessionId: 'shadow-1',
        custom: {
          [SHADOW_OF_METADATA_KEY]: 's1',
          [SHADOW_FORK_POINT_METADATA_KEY]: 3,
          [SHADOW_CREATED_WORKSPACE_METADATA_KEY]: true,
        },
        contextMessages: [{}, {}, {}, { text: 'a' }, { text: 'b' }],
        enqueue,
        append: vi.fn(),
      }),
    );

    const info = await coordinator().exitShadow('shadow-1');

    expect(sourceAppend).toHaveBeenCalledWith({ text: 'a' }, { text: 'b' });
    expect(info.direction).toBe('exit');
    expect(info.toSessionId).toBe('s1');
    expect(deleteSession).toHaveBeenCalledWith('shadow-1');
    expect(catalogDelete).toHaveBeenCalledOnce();
    const event = publish.mock.calls[0]![0] as SessionShadowSwitched;
    expect(event.sessionId).toBe('s1');
    expect(event.direction).toBe('exit');
  });

  it('exitShadow rejects a session without shadow provenance', async () => {
    live.set(
      'plain',
      fakeSessionHandle({
        sessionId: 'plain',
        custom: undefined,
        contextMessages: [],
        enqueue: vi.fn(async () => ({})),
        append: vi.fn(),
      }),
    );
    await expect(coordinator().exitShadow('plain')).rejects.toThrowError(/not a shadow session/);
  });
});
