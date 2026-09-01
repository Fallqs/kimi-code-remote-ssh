import { describe, expect, it } from 'vitest';

import {
  BASH,
  POSIX_ONLY,
  collectOutput,
  createLinkedPair,
  isPidGone,
  waitForCondition,
} from './helpers';

describe('server: stdin EOF', () => {
  it('shuts down with reason eof when the input ends', async () => {
    const pair = await createLinkedPair();

    pair.clientToServer.end();

    const info = await pair.server.waitClosed();
    expect(info.reason).toBe('eof');
    expect(info.error).toBeUndefined();

    // The client observes the transport closing and rejects further calls.
    await waitForCondition(() => pair.client.closed);
    await expect(pair.client.call('fs.exists', { path: '/x' })).rejects.toMatchObject({
      code: 'ECLOSED',
    });
  });

  it.skipIf(!POSIX_ONLY || BASH === undefined)(
    'kills all live process groups when the input ends',
    async () => {
      const pair = await createLinkedPair();
      const proc = await pair.client.spawn({
        cmd: BASH!,
        args: ['-c', 'sleep 300 & echo $!; wait'],
      });
      const out = collectOutput(proc.stdout);
      await out.waitFor('\n');
      const sleepPid = Number.parseInt(out.text().trim(), 10);
      expect(sleepPid).toBeGreaterThan(0);

      // The transport drops: the client never receives an exit frame.
      pair.clientToServer.end();

      const info = await pair.server.waitClosed();
      expect(info.reason).toBe('eof');
      await waitForCondition(() => isPidGone(proc.pid) && isPidGone(sleepPid));
      expect(await proc.wait()).toBeNull();
    },
  );
});
