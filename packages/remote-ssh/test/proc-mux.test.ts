import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BASH,
  POSIX_ONLY,
  closePair,
  collectOutput,
  createLinkedPair,
  isPidGone,
  makeTempDir,
  removeTempDir,
  waitForCondition,
  type LinkedPair,
} from './helpers';

describe('server: proc mux', () => {
  let pair: LinkedPair;

  beforeEach(async () => {
    pair = await createLinkedPair();
  });

  afterEach(async () => {
    await closePair(pair);
  });

  it.skipIf(BASH === undefined)('spawn captures stdout and exit code', async () => {
    const proc = await pair.client.spawn({ cmd: BASH!, args: ['-c', 'echo hi'] });
    const out = collectOutput(proc.stdout);
    expect(proc.pid).toBeGreaterThan(0);
    expect(proc.channel).toBeGreaterThanOrEqual(1);
    expect(await proc.wait()).toBe(0);
    expect(proc.exitCode).toBe(0);
    expect(proc.exitSignal).toBeNull();
    expect(await out.done).toBe('hi\n');
  });

  it.skipIf(BASH === undefined)('propagates non-zero exit codes', async () => {
    const proc = await pair.client.spawn({ cmd: BASH!, args: ['-c', 'exit 3'] });
    expect(await proc.wait()).toBe(3);
  });

  it.skipIf(BASH === undefined)('captures stderr on its own channel', async () => {
    const proc = await pair.client.spawn({
      cmd: BASH!,
      args: ['-c', 'echo out; echo err >&2'],
    });
    const out = collectOutput(proc.stdout);
    const err = collectOutput(proc.stderr);
    expect(await proc.wait()).toBe(0);
    expect(await out.done).toBe('out\n');
    expect(await err.done).toBe('err\n');
  });

  it.skipIf(BASH === undefined)('multiplexes two concurrent spawns', async () => {
    const procA = await pair.client.spawn({
      cmd: BASH!,
      args: ['-c', 'for i in 1 2 3; do echo "a$i"; sleep 0.05; done'],
    });
    const procB = await pair.client.spawn({
      cmd: BASH!,
      args: ['-c', 'for i in 1 2 3; do echo "b$i"; sleep 0.05; done'],
    });
    expect(procA.channel).not.toBe(procB.channel);

    const outA = collectOutput(procA.stdout);
    const outB = collectOutput(procB.stdout);
    const [codeA, codeB] = await Promise.all([procA.wait(), procB.wait()]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    expect(await outA.done).toBe('a1\na2\na3\n');
    expect(await outB.done).toBe('b1\nb2\nb3\n');
  });

  it.skipIf(BASH === undefined)('round-trips stdin through cat', async () => {
    const proc = await pair.client.spawn({ cmd: BASH!, args: ['-c', 'cat'] });
    const out = collectOutput(proc.stdout);

    proc.stdin.write('hello\n');
    await out.waitFor('hello\n');
    proc.stdin.write('second line\n');
    await out.waitFor('second line\n');
    proc.stdin.end();

    expect(await proc.wait()).toBe(0);
    expect(await out.done).toBe('hello\nsecond line\n');
  });

  it.skipIf(BASH === undefined)('overlays env on the server environment', async () => {
    const proc = await pair.client.spawn({
      cmd: BASH!,
      args: ['-c', 'echo "$RTS_TEST_VAR"'],
      env: { RTS_TEST_VAR: '42' },
    });
    const out = collectOutput(proc.stdout);
    expect(await proc.wait()).toBe(0);
    expect(await out.done).toBe('42\n');
  });

  it.skipIf(BASH === undefined)('honors the cwd parameter', async () => {
    const tempDir = await makeTempDir();
    try {
      await pair.client.fs.writeText(join(tempDir, 'marker.txt'), 'marker-content');
      const proc = await pair.client.spawn({
        cmd: BASH!,
        args: ['-c', 'cat marker.txt'],
        cwd: tempDir,
      });
      const out = collectOutput(proc.stdout);
      expect(await proc.wait()).toBe(0);
      expect(await out.done).toBe('marker-content');
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it('rejects the spawn call when the command does not exist', async () => {
    await expect(
      pair.client.spawn({ cmd: 'rts-no-such-binary-9f8e7d6c', args: [] }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!POSIX_ONLY)('kill signals the whole process group', async () => {
    const proc = await pair.client.spawn({
      cmd: BASH!,
      args: ['-c', 'sleep 100 & echo $!; wait'],
    });
    const out = collectOutput(proc.stdout);
    await out.waitFor('\n');
    const sleepPid = Number.parseInt(out.text().trim(), 10);
    expect(sleepPid).toBeGreaterThan(0);

    proc.kill(); // default SIGTERM to the group

    expect(await proc.wait()).toBeNull();
    expect(proc.exitSignal).toBe('SIGTERM');
    // Both the bash leader and the backgrounded sleep are gone.
    await waitForCondition(() => isPidGone(proc.pid) && isPidGone(sleepPid));
  });

  it.skipIf(!POSIX_ONLY)('kill accepts a custom signal', async () => {
    const proc = await pair.client.spawn({ cmd: BASH!, args: ['-c', 'sleep 100'] });
    proc.kill('SIGKILL');
    expect(await proc.wait()).toBeNull();
    expect(proc.exitSignal).toBe('SIGKILL');
    await waitForCondition(() => isPidGone(proc.pid));
  });
});
