import { Duplex, PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { RtsClient, type RtsClientCloseInfo } from '#/client/client';
import { encodeFrame } from '#/protocol/codec';

import { BASH, collectOutput, createLinkedPair, fakeFacts, waitForCondition } from './helpers';

function rawPair(): { clientToServer: PassThrough; serverToClient: PassThrough } {
  return { clientToServer: new PassThrough(), serverToClient: new PassThrough() };
}

function writeHello(stream: PassThrough, protocol = 1): void {
  stream.write(encodeFrame({ type: 'hello', protocol, version: 'test', facts: fakeFacts() }));
}

describe('client', () => {
  it('rejects a non-1 protocol version', async () => {
    const { clientToServer, serverToClient } = rawPair();
    writeHello(serverToClient, 2);
    await expect(
      RtsClient.connect({ readable: serverToClient, writable: clientToServer }),
    ).rejects.toMatchObject({ code: 'EPROTOCOL' });
    serverToClient.destroy();
    clientToServer.destroy();
  });

  it('rejects when the first frame is not hello', async () => {
    const { clientToServer, serverToClient } = rawPair();
    serverToClient.write(encodeFrame({ type: 'ok', id: 1, result: {} }));
    await expect(
      RtsClient.connect({ readable: serverToClient, writable: clientToServer }),
    ).rejects.toMatchObject({ code: 'EPROTOCOL' });
    serverToClient.destroy();
    clientToServer.destroy();
  });

  it('rejects on garbage bytes', async () => {
    const { clientToServer, serverToClient } = rawPair();
    serverToClient.write('this is not json\n');
    await expect(
      RtsClient.connect({ readable: serverToClient, writable: clientToServer }),
    ).rejects.toThrow(/invalid JSON/);
    serverToClient.destroy();
    clientToServer.destroy();
  });

  it('times out when no hello arrives', async () => {
    const { clientToServer, serverToClient } = rawPair();
    await expect(
      RtsClient.connect({ readable: serverToClient, writable: clientToServer }, { timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    serverToClient.destroy();
    clientToServer.destroy();
  });

  it('accepts a single Duplex as the transport', async () => {
    const { clientToServer, serverToClient } = rawPair();
    const duplex = Duplex.from({ readable: serverToClient, writable: clientToServer });
    writeHello(serverToClient);
    const client = await RtsClient.connect(duplex);
    expect(client.facts.shellName).toBe('bash');
    await client.close();
    duplex.destroy();
  });

  it('rejects pending calls on transport EOF', async () => {
    const { clientToServer, serverToClient } = rawPair();
    writeHello(serverToClient);
    const client = await RtsClient.connect({ readable: serverToClient, writable: clientToServer });

    const call = client.call('fs.readText', { path: '/x' });
    serverToClient.destroy(); // the transport drops without a reply

    await expect(call).rejects.toMatchObject({ code: 'ECLOSED' });
    await expect(client.call('fs.exists', { path: '/x' })).rejects.toMatchObject({
      code: 'ECLOSED',
    });
    clientToServer.destroy();
  });

  it('fires onClose exactly once on remote EOF', async () => {
    const { clientToServer, serverToClient } = rawPair();
    writeHello(serverToClient);
    const infos: RtsClientCloseInfo[] = [];
    const client = await RtsClient.connect(
      { readable: serverToClient, writable: clientToServer },
      { onClose: info => infos.push(info) },
    );

    serverToClient.destroy();
    await waitForCondition(() => client.closed);
    expect(infos).toHaveLength(1);
    expect(infos[0]!.reason).toBe('eof');
    clientToServer.destroy();
  });

  it('times out individual calls', async () => {
    const { clientToServer, serverToClient } = rawPair();
    writeHello(serverToClient);
    const client = await RtsClient.connect(
      { readable: serverToClient, writable: clientToServer },
      { timeoutMs: 50 },
    );
    // No server: the call frame is written into the void.
    await expect(client.call('fs.readText', { path: '/x' })).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    await client.close();
    clientToServer.destroy();
    serverToClient.destroy();
  });

  it('close() rejects pending calls, fires onClose, and is idempotent', async () => {
    const { clientToServer, serverToClient } = rawPair();
    writeHello(serverToClient);
    const infos: RtsClientCloseInfo[] = [];
    const client = await RtsClient.connect(
      { readable: serverToClient, writable: clientToServer },
      { onClose: info => infos.push(info) },
    );

    const pending = client.call('fs.readText', { path: '/x' });
    await client.close();
    await client.close();

    await expect(pending).rejects.toMatchObject({ code: 'ECLOSED' });
    await expect(client.call('fs.exists', { path: '/x' })).rejects.toMatchObject({
      code: 'ECLOSED',
    });
    expect(infos).toEqual([{ reason: 'closed', error: undefined }]);
    serverToClient.destroy();
  });

  it.skipIf(BASH === undefined)('ends process streams and resolves wait() null on EOF', async () => {
    const pair = await createLinkedPair();
    const proc = await pair.client.spawn({ cmd: BASH!, args: ['-c', 'sleep 100'] });
    const out = collectOutput(proc.stdout);

    pair.serverToClient.destroy(); // transport drops
    expect(await proc.wait()).toBeNull();
    expect(proc.exitCode).toBeNull();
    expect(await out.done).toBe('');

    await pair.client.close();
  });
});
