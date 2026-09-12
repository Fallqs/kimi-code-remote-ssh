import { rm } from 'node:fs/promises';

import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import {
  IShadowRegistry,
  ShadowRegistryService,
} from '@moonshot-ai/agent-core-v2/features/shadow/shadowRegistry';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { describe, expect, it } from 'vitest';

import { defineKlientConformance } from './helpers/conformance.js';
import { createKlient } from '../src/transports/memory/index.js';
import {
  createMemoryDispatcher,
  type ScopeLike,
} from '../src/transports/memory/dispatcher.js';
import { RPCError } from '../src/core/errors.js';
import { makeEngine } from './helpers/engine.js';

defineKlientConformance('memory', async () => {
  const { homeDir, app } = await makeEngine();
  const klient = createKlient({ scope: app });
  return {
    klient,
    app,
    cleanup: async () => {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
});

describe('memory dispatcher specifics', () => {
  it('rejects unknown services and methods with RPCError(40001)', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'noSuchService', 'get', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    await expect(dispatcher.call({}, 'sessionIndex', 'noSuchMethod', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('reads non-function members as properties', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'bootstrapService', 'platform', [])).resolves.toBe(
      process.platform,
    );
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('rejects session/agent scopes for now', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(
      dispatcher.call({ sessionId: 's1' }, 'sessionIndex', 'list', [{}]),
    ).rejects.toBeInstanceOf(RPCError);
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('delivers wire-cloned payloads (no live object identity)', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const list = await klient.global.workspaces.list();
    // Mutating the result must not affect what a second call returns.
    (list as unknown[]).push({ id: 'polluted' });
    const again = await klient.global.workspaces.list();
    expect(again.some((w) => w.id === 'polluted')).toBe(false);
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });
});

describe('memory dispatcher shadow routing', () => {
  function makeShadowRoot() {
    const seen: string[] = [];
    const sessions = new Map<string, unknown>();
    const registry = new ShadowRegistryService(
      {
        listRecent: async () => ({ items: [], nextCursor: undefined }),
      } as unknown as ConstructorParameters<typeof ShadowRegistryService>[0],
      {} as ConstructorParameters<typeof ShadowRegistryService>[1],
    );
    const root: ScopeLike = {
      accessor: {
        get(token: never): unknown {
          if (token === IShadowRegistry) return registry;
          if (token === ISessionManager) {
            return {
              get: (id: string) => {
                seen.push(id);
                return sessions.get(id);
              },
            };
          }
          return undefined;
        },
      },
    };
    return { root, registry, sessions, seen };
  }

  function fakeSession(id: string) {
    return {
      id,
      accessor: {
        get(token: never): unknown {
          if (token === ISessionMetadata) return { read: async () => ({ id }) };
          return undefined;
        },
      },
    };
  }

  it('routes a source-scoped call to the live shadow session', async () => {
    const { root, registry, sessions, seen } = makeShadowRoot();
    sessions.set('s1', fakeSession('s1'));
    sessions.set('shadow-1', fakeSession('shadow-1'));
    registry.noteEnter('s1', 'shadow-1');
    const dispatcher = createMemoryDispatcher(root);

    await expect(
      dispatcher.call({ sessionId: 's1' }, 'sessionMetadata', 'read', []),
    ).resolves.toEqual({ id: 'shadow-1' });
    expect(seen).toEqual(['shadow-1']);
  });

  it('holds routing until the pending transition settles, then follows the alias', async () => {
    const { root, registry, sessions, seen } = makeShadowRoot();
    sessions.set('s1', fakeSession('s1'));
    sessions.set('shadow-1', fakeSession('shadow-1'));
    registry.beginTransition('s1', 'enter');
    const dispatcher = createMemoryDispatcher(root);

    let settled = false;
    const pending = dispatcher
      .call({ sessionId: 's1' }, 'sessionMetadata', 'read', [])
      .then((result) => {
        settled = true;
        return result;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    registry.noteEnter('s1', 'shadow-1');
    registry.settleTransition('s1');
    await expect(pending).resolves.toEqual({ id: 'shadow-1' });
    expect(seen).toEqual(['shadow-1']);
  });
});
