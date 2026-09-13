import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { turnKey, TurnPrompt } from '#/agent/loop/turnOps';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentShadowModeService } from '#/features/shadow/shadow';
import {
  IShadowHostSupport,
  IShadowSessionCoordinator,
  SHADOW_ACTIVE_METADATA_KEY,
  SHADOW_CREATED_WORKSPACE_METADATA_KEY,
  SHADOW_FORK_POINT_METADATA_KEY,
  SHADOW_OF_METADATA_KEY,
  SHADOW_ROOT_METADATA_KEY,
  SessionShadowSwitched,
} from '#/features/shadow/shadowCoordinator';
import { ShadowSessionCoordinatorService } from '#/features/shadow/shadowCoordinatorService';
import { IShadowRegistry, ShadowRegistryService } from '#/features/shadow/shadowRegistry';
import { AgentShadowModeService } from '#/features/shadow/shadowService';
import { EnterShadowModeInputSchema } from '#/features/shadow/tools/enter-shadow-mode/enter-shadow-mode';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { SSH_WORKDIR_FLAG_ID } from '#/workspace/workspaceSsh/flag';

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
  let registry: ShadowRegistryService;
  let holdCount: number;
  let stat: ReturnType<typeof vi.fn<(path: string) => Promise<{ isDirectory: boolean }>>>;
  let flagsEnabled: (id: string) => boolean;

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
    holdCount = 0;
    stat = vi.fn(async (_path: string) => ({ isDirectory: true }));
    flagsEnabled = () => false;
    registry = new ShadowRegistryService(
      {
        _serviceBrand: undefined,
        listRecent: async () => ({ items: [], nextCursor: undefined }),
      } as unknown as ISessionIndex,
      { _serviceBrand: undefined } as unknown as ISessionManager,
    );
    disposables.add(registry);

    ix.stub(ISessionContext, sessionContextStub('s1', '/home/user/.kimi-code'));
    ix.stub(IAgentScopeContext, agentScopeContextStub(MAIN_AGENT_ID));
    ix.stub(ISessionMetadata, sessionMetadataStub(undefined));
    ix.stub(IEventBus, bus.bus);
    ix.stub(IShadowRegistry, registry);
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      homeDir: '/home/user/.kimi-code',
      osHomeDir: '/home/user',
    } as unknown as IBootstrapService);
    ix.stub(IFlagService, {
      _serviceBrand: undefined,
      enabled: (id: string) => flagsEnabled(id),
    } as unknown as IFlagService);
    ix.stub(IHostFileSystem, {
      _serviceBrand: undefined,
      stat: (path: string) => stat(path),
    } as unknown as IHostFileSystem);
    ix.stub(IAgentLoopService, {
      _serviceBrand: undefined,
      acquireAdmissionHold: () => {
        holdCount += 1;
        return { dispose: () => { holdCount -= 1; } };
      },
    } as unknown as IAgentLoopService);
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
    await expect(svc.requestEnter()).rejects.toThrowError(/main agent/);
    await expect(svc.requestExit()).rejects.toThrowError(/main agent/);
  });

  it('refuses to enter when the host does not support shadow mode', async () => {
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    expect(svc.hostSupported()).toBe(false);
    await expect(svc.requestEnter()).rejects.toThrowError(/not supported/);
  });

  it('enters at the turn boundary once armed', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    expect(svc.hostSupported()).toBe(true);
    await svc.requestEnter();
    expect(coordinator.enterShadow).not.toHaveBeenCalled();
    bus.fireTurnEnded();
    await vi.waitFor(() =>
      expect(coordinator.enterShadow).toHaveBeenCalledWith('s1', '/home/user/.kimi-code'),
    );
  });

  it('exits at the turn boundary once armed', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    ix.stub(ISessionMetadata, sessionMetadataStub({ [SHADOW_OF_METADATA_KEY]: 's0' }));
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await svc.requestExit();
    bus.fireTurnEnded();
    await vi.waitFor(() => expect(coordinator.exitShadow).toHaveBeenCalledWith('s1'));
  });

  it('rejects a second pending request', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await svc.requestEnter();
    await expect(svc.requestEnter()).rejects.toThrowError(/already pending/);
  });

  it('surfaces a switch failure as a one-off reminder notification', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    coordinator.enterShadow.mockRejectedValue(new Error('boom'));
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await svc.requestEnter();
    bus.fireTurnEnded();
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Shadow mode enter failed: boom', {
        variant: 'shadow_mode',
      }),
    );
  });

  it('arms the transition gate and admission hold at requestEnter', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await svc.requestEnter();
    expect(registry.whenTransitionSettled('s1')).toBeDefined();
    expect(holdCount).toBe(1);
    expect(coordinator.enterShadow).not.toHaveBeenCalled();
  });

  it('arms the exit gate against the source session id at requestExit', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    ix.stub(ISessionMetadata, sessionMetadataStub({ [SHADOW_OF_METADATA_KEY]: 's0' }));
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await svc.requestExit();
    expect(registry.whenTransitionSettled('s0')).toBeDefined();
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();
    expect(holdCount).toBe(1);
  });

  it('releases the gate and hold when the enter switch fails', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    coordinator.enterShadow.mockRejectedValue(new Error('boom'));
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await svc.requestEnter();
    const gate = registry.whenTransitionSettled('s1');
    expect(gate).toBeDefined();
    bus.fireTurnEnded();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    await gate;
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();
    expect(holdCount).toBe(0);
  });

  it('releases the gate and hold when the exit switch fails', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    ix.stub(ISessionMetadata, sessionMetadataStub({ [SHADOW_OF_METADATA_KEY]: 's0' }));
    coordinator.exitShadow.mockRejectedValue(new Error('boom'));
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await svc.requestExit();
    bus.fireTurnEnded();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(registry.whenTransitionSettled('s0')).toBeUndefined();
    expect(holdCount).toBe(0);
  });

  it('enters with an explicit local path after validating it exists', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    const root = await svc.requestEnter('/data/work');
    expect(root).toBe('/data/work');
    expect(stat).toHaveBeenCalledWith('/data/work');
    bus.fireTurnEnded();
    await vi.waitFor(() =>
      expect(coordinator.enterShadow).toHaveBeenCalledWith('s1', '/data/work'),
    );
  });

  it('expands ~ in local paths against the os home', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    const root = await svc.requestEnter('~/work');
    expect(root).toBe('/home/user/work');
    expect(stat).toHaveBeenCalledWith('/home/user/work');
  });

  it('rejects a relative path without arming a switch', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await expect(svc.requestEnter('rel/dir')).rejects.toThrowError(/absolute path/);
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();
    expect(holdCount).toBe(0);
    bus.fireTurnEnded();
    expect(coordinator.enterShadow).not.toHaveBeenCalled();
  });

  it('rejects a missing local path without arming a switch', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    stat.mockRejectedValue(new Error('ENOENT'));
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await expect(svc.requestEnter('/nope')).rejects.toThrowError(/does not exist/);
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();
    expect(holdCount).toBe(0);
  });

  it('rejects a non-directory local path', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    stat.mockResolvedValue({ isDirectory: false });
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await expect(svc.requestEnter('/data/file')).rejects.toThrowError(/not a directory/);
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();
  });

  it('rejects an ssh target while the ssh-workdir flag is off', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await expect(svc.requestEnter('ssh://host/dir')).rejects.toThrowError(/ssh-workdir/);
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();
    expect(holdCount).toBe(0);
    expect(stat).not.toHaveBeenCalled();
  });

  it('rejects a malformed ssh spec even with the flag on', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    flagsEnabled = (id) => id === SSH_WORKDIR_FLAG_ID;
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await expect(svc.requestEnter('ssh://host')).rejects.toThrowError(/invalid ssh shadow target/);
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();
  });

  it('canonicalizes an ssh target with the flag on and skips the local stat', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    flagsEnabled = (id) => id === SSH_WORKDIR_FLAG_ID;
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    const root = await svc.requestEnter('ssh://user@host:22/dir/');
    expect(root).toBe('ssh://user@host/dir');
    expect(stat).not.toHaveBeenCalled();
    bus.fireTurnEnded();
    await vi.waitFor(() =>
      expect(coordinator.enterShadow).toHaveBeenCalledWith('s1', 'ssh://user@host/dir'),
    );
  });

  it('still allows a valid request after a rejected one', async () => {
    ix.stub(IShadowHostSupport, { _serviceBrand: undefined });
    const svc = ix.createInstance(new SyncDescriptor(AgentShadowModeService)) as AgentShadowModeService;
    await expect(svc.requestEnter('rel/dir')).rejects.toThrowError();
    await svc.requestEnter('/data/work');
    bus.fireTurnEnded();
    await vi.waitFor(() =>
      expect(coordinator.enterShadow).toHaveBeenCalledWith('s1', '/data/work'),
    );
  });
});

interface FakeSessionHandleOpts {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly custom?: Record<string, unknown>;
  readonly contextMessages: unknown[];
  readonly enqueue: ReturnType<typeof vi.fn>;
  readonly append: ReturnType<typeof vi.fn>;
  readonly wireRecords?: Record<string, unknown>[];
  readonly nextTurnId?: number;
  readonly order?: string[];
}

function fakeSessionHandle(opts: FakeSessionHandleOpts) {
  const turnState = {
    nextTurnId: opts.nextTurnId ?? 0,
    cancelledTurnIds: [] as number[],
    anchorTurnIds: [] as number[],
  };
  const dispatched: TurnPrompt[] = [];
  const releaseAdmissionHold = vi.fn();
  const metadataUpdate = vi.fn(async () => {});
  const flush = vi.fn(async () => {});
  const agentHandle = {
    accessor: {
      get: (token: unknown) => {
        if (token === IAgentContextMemoryService) {
          return { get: () => opts.contextMessages, append: opts.append };
        }
        if (token === IAgentPromptService) return { enqueue: opts.enqueue };
        if (token === IAgentShadowModeService) return { releaseAdmissionHold };
        if (token === IAgentStateService) {
          return {
            has: (key: unknown) => key === turnKey,
            get: (key: unknown) => {
              if (key === turnKey) return turnState;
              throw new Error('unknown state key');
            },
          };
        }
        if (token === IWireService) {
          return {
            readJournal: async function* () {
              for (const record of opts.wireRecords ?? []) yield record;
            },
            flush,
          };
        }
        if (token === IEventDispatcher) {
          return {
            dispatch: async (event: TurnPrompt) => {
              dispatched.push(event);
              opts.order?.push('prompt');
              turnState.nextTurnId += 1;
            },
          };
        }
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
            update: metadataUpdate,
          };
        }
        if (token === ISessionContext) return { sessionId: opts.sessionId, cwd: opts.cwd ?? '/src' };
        if (token === IAgentLifecycleService) {
          return { handleOf: (id: string) => (id === MAIN_AGENT_ID ? agentHandle : undefined) };
        }
        return undefined;
      },
    },
    dispose: () => {},
    dispatched,
    turnState,
    releaseAdmissionHold,
    metadataUpdate,
    flush,
  };
}

describe('ShadowSessionCoordinatorService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let publish: ReturnType<typeof vi.fn>;
  let forkFrom: ReturnType<typeof vi.fn<(root: string, src: unknown, opts: unknown) => Promise<unknown>>>;
  let deleteSession: ReturnType<typeof vi.fn>;
  let catalogDelete: ReturnType<typeof vi.fn>;
  let registry: ShadowRegistryService;
  let flagsEnabled: (id: string) => boolean;
  const live = new Map<string, ReturnType<typeof fakeSessionHandle>>();

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    publish = vi.fn();
    forkFrom = vi.fn<(root: string, src: unknown, opts: unknown) => Promise<unknown>>();
    deleteSession = vi.fn(async () => {});
    catalogDelete = vi.fn(async () => {});
    live.clear();
    flagsEnabled = () => false;

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
      listRecent: async () => ({ items: [], nextCursor: undefined }),
    } as unknown as ISessionIndex);
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      homeDir: '/home/user/.kimi-code',
      osHomeDir: '/home/user',
    } as unknown as IBootstrapService);
    ix.stub(IFlagService, {
      _serviceBrand: undefined,
      enabled: (id: string) => flagsEnabled(id),
    } as unknown as IFlagService);
    ix.stub(IEventService, {
      _serviceBrand: undefined,
      publish,
    } as unknown as IEventService);
    ix.stub(IWorkspaceService, {
      _serviceBrand: undefined,
      list: async () => [],
      delete: catalogDelete,
    } as unknown as IWorkspaceService);
    registry = disposables.add(
      ix.createInstance(new SyncDescriptor(ShadowRegistryService)) as ShadowRegistryService,
    );
    ix.stub(IShadowRegistry, registry);
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
    forkFrom.mockImplementation((root: string, src: unknown, opts: unknown) => {
      const target = fakeSessionHandle({
        sessionId: 'shadow-1',
        custom: (opts as { metadata?: Record<string, unknown> }).metadata,
        contextMessages: [],
        enqueue,
        append: vi.fn(),
      });
      live.set('shadow-1', target);
      return Promise.resolve(target);
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
      [SHADOW_ACTIVE_METADATA_KEY]: true,
      [SHADOW_ROOT_METADATA_KEY]: '/home/user/.kimi-code',
      [SHADOW_CREATED_WORKSPACE_METADATA_KEY]: true,
    });
    expect((opts as { admissionHeldAgentIds: readonly string[] }).admissionHeldAgentIds).toEqual([
      MAIN_AGENT_ID,
    ]);
    expect(info).toEqual({
      fromSessionId: 's1',
      toSessionId: 'shadow-1',
      workspaceRoot: '/home/user/.kimi-code',
      direction: 'enter',
    });
    expect(registry.isShadowed('s1')).toBe(true);
    expect(registry.isShadowId('shadow-1')).toBe(true);
    expect(registry.effectiveId('s1')).toBe('shadow-1');
    expect(registry.presentedId('shadow-1')).toBe('s1');
    expect(enqueue).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    const event = publish.mock.calls[0]![0] as SessionShadowSwitched;
    expect(event.type).toBe('event.session.shadow_switched');
    expect(event.sessionId).toBe('s1');
    expect(event.toSessionId).toBe('shadow-1');
  });

  it('enterShadow forks into an explicit local path and records shadow_root', async () => {
    const enqueue = vi.fn(async () => ({}));
    live.set(
      's1',
      fakeSessionHandle({ sessionId: 's1', contextMessages: [], enqueue, append: vi.fn() }),
    );
    forkFrom.mockImplementation((root: string, src: unknown, opts: unknown) => {
      const target = fakeSessionHandle({
        sessionId: 'shadow-1',
        custom: (opts as { metadata?: Record<string, unknown> }).metadata,
        contextMessages: [],
        enqueue,
        append: vi.fn(),
      });
      live.set('shadow-1', target);
      return Promise.resolve(target);
    });

    const info = await coordinator().enterShadow('s1', '/data/work');

    const [root, , opts] = forkFrom.mock.calls[0]!;
    expect(root).toBe('/data/work');
    expect((opts as { metadata: Record<string, unknown> }).metadata).toEqual({
      [SHADOW_OF_METADATA_KEY]: 's1',
      [SHADOW_FORK_POINT_METADATA_KEY]: 0,
      [SHADOW_ACTIVE_METADATA_KEY]: true,
      [SHADOW_ROOT_METADATA_KEY]: '/data/work',
      [SHADOW_CREATED_WORKSPACE_METADATA_KEY]: true,
    });
    expect(info.workspaceRoot).toBe('/data/work');
    const [continuation] = enqueue.mock.calls[0] as unknown as [
      { message: { content: { text: string }[] } },
    ];
    expect(continuation.message.content[0]!.text).toContain('/data/work');
  });

  it('enterShadow canonicalizes an ssh target when the ssh-workdir flag is on', async () => {
    flagsEnabled = (id) => id === SSH_WORKDIR_FLAG_ID;
    const enqueue = vi.fn(async () => ({}));
    live.set(
      's1',
      fakeSessionHandle({ sessionId: 's1', contextMessages: [], enqueue, append: vi.fn() }),
    );
    forkFrom.mockImplementation((root: string, src: unknown, opts: unknown) => {
      const target = fakeSessionHandle({
        sessionId: 'shadow-1',
        custom: (opts as { metadata?: Record<string, unknown> }).metadata,
        contextMessages: [],
        enqueue,
        append: vi.fn(),
      });
      live.set('shadow-1', target);
      return Promise.resolve(target);
    });

    const info = await coordinator().enterShadow('s1', 'ssh://user@host:22/dir/');

    const [root, , opts] = forkFrom.mock.calls[0]!;
    expect(root).toBe('ssh://user@host/dir');
    expect(
      (opts as { metadata: Record<string, unknown> }).metadata[SHADOW_ROOT_METADATA_KEY],
    ).toBe('ssh://user@host/dir');
    expect(info.workspaceRoot).toBe('ssh://user@host/dir');
    const [continuation] = enqueue.mock.calls[0] as unknown as [
      { message: { content: { text: string }[] } },
    ];
    expect(continuation.message.content[0]!.text).toContain('remote host ssh://user@host/dir');
  });

  it('enterShadow rejects an ssh target when the ssh-workdir flag is off', async () => {
    const enqueue = vi.fn(async () => ({}));
    live.set(
      's1',
      fakeSessionHandle({ sessionId: 's1', contextMessages: [], enqueue, append: vi.fn() }),
    );

    await expect(coordinator().enterShadow('s1', 'ssh://host/dir')).rejects.toThrowError(
      /ssh-workdir/,
    );
    expect(forkFrom).not.toHaveBeenCalled();
    expect(registry.isShadowed('s1')).toBe(false);
  });

  it('enterShadow rejects a relative target path', async () => {
    const enqueue = vi.fn(async () => ({}));
    live.set(
      's1',
      fakeSessionHandle({ sessionId: 's1', contextMessages: [], enqueue, append: vi.fn() }),
    );

    await expect(coordinator().enterShadow('s1', 'rel/dir')).rejects.toThrowError(/absolute path/);
    expect(forkFrom).not.toHaveBeenCalled();
  });

  it('exitShadow cleans up the recorded shadow_root workspace and reports the source root', async () => {
    ix.stub(IWorkspaceService, {
      _serviceBrand: undefined,
      list: async () => [
        { id: 'wd_data', root: '/data/work', name: 'work', createdAt: 0, lastOpenedAt: 0 },
      ],
      delete: catalogDelete,
    } as unknown as IWorkspaceService);
    const enqueue = vi.fn(async () => ({}));
    live.set(
      's1',
      fakeSessionHandle({
        sessionId: 's1',
        cwd: '/src',
        contextMessages: [{}, {}, {}],
        enqueue,
        append: vi.fn(),
      }),
    );
    live.set(
      'shadow-1',
      fakeSessionHandle({
        sessionId: 'shadow-1',
        cwd: '/data/work',
        custom: {
          [SHADOW_OF_METADATA_KEY]: 's1',
          [SHADOW_FORK_POINT_METADATA_KEY]: 3,
          [SHADOW_ROOT_METADATA_KEY]: '/data/work',
          [SHADOW_CREATED_WORKSPACE_METADATA_KEY]: true,
        },
        contextMessages: [{}, {}, {}, { text: 'a' }],
        enqueue,
        append: vi.fn(),
      }),
    );

    const info = await coordinator().exitShadow('shadow-1');

    expect(info.workspaceRoot).toBe('/src');
    expect(catalogDelete).toHaveBeenCalledWith('wd_data');
    const event = publish.mock.calls[0]![0] as SessionShadowSwitched;
    expect(event.direction).toBe('exit');
    expect(event.workspaceRoot).toBe('/src');
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
    const sourceFlush = live.get('s1')!.flush;
    expect(sourceFlush).toHaveBeenCalledOnce();
    expect(sourceFlush.mock.invocationCallOrder[0]!).toBeGreaterThan(
      sourceAppend.mock.invocationCallOrder[0]!,
    );
    expect(sourceFlush.mock.invocationCallOrder[0]!).toBeLessThan(
      publish.mock.invocationCallOrder[0]!,
    );
    expect(info.direction).toBe('exit');
    expect(info.toSessionId).toBe('s1');
    expect(deleteSession).toHaveBeenCalledWith('shadow-1');
    expect(catalogDelete).toHaveBeenCalledOnce();
    const shadow = live.get('shadow-1')!;
    expect(shadow.metadataUpdate).toHaveBeenCalledWith(
      {
        custom: {
          [SHADOW_OF_METADATA_KEY]: 's1',
          [SHADOW_FORK_POINT_METADATA_KEY]: 3,
          [SHADOW_CREATED_WORKSPACE_METADATA_KEY]: true,
        },
      },
      { touchUpdatedAt: false },
    );
    expect(live.get('s1')!.releaseAdmissionHold).toHaveBeenCalledOnce();
    expect(registry.isShadowId('shadow-1')).toBe(false);
    expect(registry.isShadowed('s1')).toBe(false);
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

  it('exitShadow replays the shadow’s post-fork turn prompts onto the source before appending rows', async () => {
    const order: string[] = [];
    const sourceAppend = vi.fn(() => {
      order.push('append');
    });
    const enqueue = vi.fn(async () => {
      order.push('enqueue');
      return {};
    });
    const sharedPrompt = {
      type: 'turn.prompt',
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'one' }],
      origin: { kind: 'user' },
      promptId: 'p1',
      time: 1,
    };
    live.set(
      's1',
      fakeSessionHandle({
        sessionId: 's1',
        contextMessages: [{}, {}, {}],
        enqueue,
        append: sourceAppend,
        wireRecords: [sharedPrompt],
        nextTurnId: 1,
        order,
      }),
    );
    live.set(
      'shadow-1',
      fakeSessionHandle({
        sessionId: 'shadow-1',
        custom: {
          [SHADOW_OF_METADATA_KEY]: 's1',
          [SHADOW_FORK_POINT_METADATA_KEY]: 3,
        },
        contextMessages: [{}, {}, {}, { text: 'a' }, { text: 'b' }],
        enqueue,
        append: vi.fn(),
        wireRecords: [
          sharedPrompt,
          {
            type: 'turn.prompt',
            agentId: MAIN_AGENT_ID,
            input: [{ type: 'text', text: 'two' }],
            origin: { kind: 'user' },
            promptId: 'p2',
            time: 2,
          },
          {
            type: 'turn.prompt',
            agentId: MAIN_AGENT_ID,
            input: [],
            origin: { kind: 'system_trigger', name: 'goal_continuation' },
            time: 3,
          },
          { type: 'turn.ended', agentId: MAIN_AGENT_ID, turnId: 2, reason: 'completed', time: 4 },
        ],
        nextTurnId: 3,
      }),
    );

    await coordinator().exitShadow('shadow-1');

    const source = live.get('s1')!;
    expect(source.dispatched).toHaveLength(2);
    expect(source.dispatched[0]).toBeInstanceOf(TurnPrompt);
    expect(source.dispatched[0]!.origin).toEqual({ kind: 'user' });
    expect(source.dispatched[0]!.input).toEqual([{ type: 'text', text: 'two' }]);
    expect(source.dispatched[0]!.promptId).toBe('p2');
    expect(source.dispatched[1]!.origin).toEqual({ kind: 'system_trigger', name: 'goal_continuation' });
    expect(source.dispatched[1]!.promptId).toBeUndefined();
    expect(source.turnState.nextTurnId).toBe(3);
    expect(order).toEqual(['prompt', 'prompt', 'append', 'enqueue']);
  });

  it('exitShadow dispatches no turn prompts when the shadow ran no turns', async () => {
    const enqueue = vi.fn(async () => ({}));
    const sharedPrompt = {
      type: 'turn.prompt',
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'one' }],
      origin: { kind: 'user' },
      time: 1,
    };
    live.set(
      's1',
      fakeSessionHandle({
        sessionId: 's1',
        contextMessages: [{}, {}, {}],
        enqueue,
        append: vi.fn(),
        wireRecords: [sharedPrompt],
        nextTurnId: 1,
      }),
    );
    live.set(
      'shadow-1',
      fakeSessionHandle({
        sessionId: 'shadow-1',
        custom: {
          [SHADOW_OF_METADATA_KEY]: 's1',
          [SHADOW_FORK_POINT_METADATA_KEY]: 3,
        },
        contextMessages: [{}, {}, {}],
        enqueue,
        append: vi.fn(),
        wireRecords: [sharedPrompt],
        nextTurnId: 1,
      }),
    );

    await coordinator().exitShadow('shadow-1');

    expect(live.get('s1')!.dispatched).toHaveLength(0);
  });

  it('exitShadow tops up the source turn clock when prompt records are missing', async () => {
    const enqueue = vi.fn(async () => ({}));
    const sharedPrompt = {
      type: 'turn.prompt',
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'one' }],
      origin: { kind: 'user' },
      time: 1,
    };
    live.set(
      's1',
      fakeSessionHandle({
        sessionId: 's1',
        contextMessages: [{}, {}, {}],
        enqueue,
        append: vi.fn(),
        wireRecords: [sharedPrompt],
        nextTurnId: 1,
      }),
    );
    live.set(
      'shadow-1',
      fakeSessionHandle({
        sessionId: 'shadow-1',
        custom: {
          [SHADOW_OF_METADATA_KEY]: 's1',
          [SHADOW_FORK_POINT_METADATA_KEY]: 3,
        },
        contextMessages: [{}, {}, {}, { text: 'a' }],
        enqueue,
        append: vi.fn(),
        wireRecords: [
          sharedPrompt,
          {
            type: 'turn.prompt',
            agentId: MAIN_AGENT_ID,
            input: [{ type: 'text', text: 'two' }],
            origin: { kind: 'user' },
            time: 2,
          },
        ],
        nextTurnId: 4,
      }),
    );

    await coordinator().exitShadow('shadow-1');

    const source = live.get('s1')!;
    expect(source.dispatched).toHaveLength(3);
    expect(source.dispatched[0]!.origin).toEqual({ kind: 'user' });
    expect(source.dispatched[1]!.origin).toEqual({ kind: 'retry' });
    expect(source.dispatched[2]!.origin).toEqual({ kind: 'retry' });
    expect(source.turnState.nextTurnId).toBe(4);
  });

  it('enterShadow settles a pending transition and aborts it on failure', async () => {
    const enqueue = vi.fn(async () => ({}));
    live.set(
      's1',
      fakeSessionHandle({ sessionId: 's1', contextMessages: [], enqueue, append: vi.fn() }),
    );
    forkFrom.mockImplementation((root: string, src: unknown, opts: unknown) => {
      const target = fakeSessionHandle({
        sessionId: 'shadow-1',
        custom: (opts as { metadata?: Record<string, unknown> }).metadata,
        contextMessages: [],
        enqueue,
        append: vi.fn(),
      });
      live.set('shadow-1', target);
      return Promise.resolve(target);
    });

    registry.beginTransition('s1', 'enter');
    const gate = registry.whenTransitionSettled('s1');
    expect(gate).toBeDefined();
    await coordinator().enterShadow('s1');
    await gate;
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();

    live.delete('s1');
    live.delete('shadow-1');
    forkFrom.mockRejectedValue(new Error('fork failed'));
    live.set(
      's2',
      fakeSessionHandle({ sessionId: 's2', contextMessages: [], enqueue, append: vi.fn() }),
    );
    registry.beginTransition('s2', 'enter');
    const failedGate = registry.whenTransitionSettled('s2');
    await expect(coordinator().enterShadow('s2')).rejects.toThrowError(/fork failed/);
    await failedGate;
    expect(registry.whenTransitionSettled('s2')).toBeUndefined();
    expect(registry.isShadowed('s2')).toBe(false);
  });

  it('a full enter → exit roundtrip restores identity routing', async () => {
    const enqueue = vi.fn(async () => ({}));
    live.set(
      's1',
      fakeSessionHandle({
        sessionId: 's1',
        contextMessages: [{}, {}],
        enqueue,
        append: vi.fn(),
      }),
    );
    forkFrom.mockImplementation((root: string, src: unknown, opts: unknown) => {
      const target = fakeSessionHandle({
        sessionId: 'shadow-1',
        custom: (opts as { metadata?: Record<string, unknown> }).metadata,
        contextMessages: [{}, {}, { text: 'a' }],
        enqueue,
        append: vi.fn(),
      });
      live.set('shadow-1', target);
      return Promise.resolve(target);
    });

    await coordinator().enterShadow('s1');
    expect(registry.effectiveId('s1')).toBe('shadow-1');

    registry.beginTransition('s1', 'exit');
    await coordinator().exitShadow('shadow-1');
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();
    expect(registry.effectiveId('s1')).toBe('s1');
    expect(registry.isShadowId('shadow-1')).toBe(false);
  });
});

describe('ShadowRegistryService', () => {
  function makeRegistry(
    index: unknown = { listRecent: async () => ({ items: [], nextCursor: undefined }) },
    manager: unknown = {},
  ): ShadowRegistryService {
    return new ShadowRegistryService(
      index as ConstructorParameters<typeof ShadowRegistryService>[0],
      manager as ConstructorParameters<typeof ShadowRegistryService>[1],
    );
  }

  it('rebuilds aliases only for shadow sessions still marked active', async () => {
    const registry = makeRegistry({
      listRecent: async () => ({
        items: [
          {
            id: 'shadow-1',
            custom: { [SHADOW_OF_METADATA_KEY]: 's1', [SHADOW_ACTIVE_METADATA_KEY]: true },
          },
          { id: 'shadow-2', custom: { [SHADOW_OF_METADATA_KEY]: 's2' } },
          {
            id: 'shadow-3',
            custom: { [SHADOW_OF_METADATA_KEY]: 's3', [SHADOW_ACTIVE_METADATA_KEY]: false },
          },
        ],
        nextCursor: undefined,
      }),
    });
    await registry.ready;
    expect(registry.isShadowed('s1')).toBe(true);
    expect(registry.effectiveId('s1')).toBe('shadow-1');
    expect(registry.isShadowed('s2')).toBe(false);
    expect(registry.isShadowed('s3')).toBe(false);
  });

  it('settle and abort resolve waiters; both are no-ops without a pending transition', async () => {
    const registry = makeRegistry();
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();
    expect(() => registry.settleTransition('s1')).not.toThrow();
    expect(() => registry.abortTransition('s1')).not.toThrow();

    registry.beginTransition('s1', 'enter');
    expect(registry.whenTransitionSettled('s1')).toBeDefined();
    registry.settleTransition('s1');
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();

    registry.beginTransition('s1', 'exit');
    const gate = registry.whenTransitionSettled('s1');
    registry.abortTransition('s1');
    await gate;
    expect(registry.whenTransitionSettled('s1')).toBeUndefined();
  });

  it('a second beginTransition for the same source keeps the first gate', async () => {
    const registry = makeRegistry();
    registry.beginTransition('s1', 'enter');
    const first = registry.whenTransitionSettled('s1');
    registry.beginTransition('s1', 'exit');
    expect(registry.whenTransitionSettled('s1')).toBe(first);
    registry.settleTransition('s1');
    await first;
  });

  it('drops the alias when the shadow session closes', async () => {
    let closeHandler: ((closed: { sessionId: string }) => void) | undefined;
    const registry = makeRegistry(undefined, {
      onDidCloseSession: (handler: (closed: { sessionId: string }) => void) => {
        closeHandler = handler;
        return { dispose: () => {} };
      },
    });
    await registry.ready;
    registry.noteEnter('s1', 'shadow-1');
    expect(registry.isShadowed('s1')).toBe(true);
    closeHandler?.({ sessionId: 'shadow-1' });
    expect(registry.isShadowed('s1')).toBe(false);
    expect(registry.isShadowId('shadow-1')).toBe(false);
    closeHandler?.({ sessionId: 'unrelated' });
    expect(registry.effectiveId('s1')).toBe('s1');
  });
});

describe('EnterShadowModeInputSchema', () => {
  it('accepts an omitted or trimmed path and rejects unknown keys and empty paths', () => {
    expect(EnterShadowModeInputSchema.parse({})).toEqual({});
    expect(EnterShadowModeInputSchema.parse({ path: ' /data/work ' })).toEqual({
      path: '/data/work',
    });
    expect(() => EnterShadowModeInputSchema.parse({ bogus: 1 })).toThrow();
    expect(() => EnterShadowModeInputSchema.parse({ path: '' })).toThrow();
    expect(() => EnterShadowModeInputSchema.parse({ path: '   ' })).toThrow();
  });
});
