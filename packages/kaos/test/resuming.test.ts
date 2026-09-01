import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';

import { join } from 'pathe';
import { afterAll, describe, expect, it } from 'vitest';

import { detectEnvironmentFromNode } from '#/environment';
import {
  LocalResumingShellEnv,
  ResumingShell,
  buildResumingWrapperScript,
} from '#/stateful-shell/resuming';
import type {
  ResumingProc,
  ResumingShellEnv,
  ResumingShellFacts,
  ResumingShellFs,
  ResumingShellSpawnOptions,
} from '#/stateful-shell/resuming';

// ── Test envs ─────────────────────────────────────────────────────────────

/**
 * A fully in-memory env whose spawn returns inert, manually-driven procs —
 * used to test the shell's TS-side behavior (fg mutex, commit-flag lifecycle,
 * kill/detach sequencing) without bash.
 */
class ManualEnv implements ResumingShellEnv {
  readonly facts: ResumingShellFacts = { shell: 'bash', windows: false };
  readonly fs: ResumingShellFs;
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly procs: ManualProc[] = [];
  readonly ops: string[] = [];

  constructor() {
    this.fs = {
      readText: async (path) => {
        const text = this.files.get(path);
        if (text === undefined) throw new Error(`no such file: ${path}`);
        return text;
      },
      writeText: async (path, text) => {
        this.ops.push(`writeText ${path}`);
        this.files.set(path, text);
      },
      mkdir: async (path) => {
        this.ops.push(`mkdir ${path}`);
        this.dirs.add(path);
      },
      remove: async (path) => {
        this.ops.push(`remove ${path}`);
        this.files.delete(path);
      },
      exists: async (path) => this.files.has(path) || this.dirs.has(path),
    };
  }

  readonly spawnOptions: Array<ResumingShellSpawnOptions | undefined> = [];

  async spawn(
    args: readonly string[],
    options?: ResumingShellSpawnOptions,
  ): Promise<ResumingProc> {
    this.ops.push(`spawn ${args.join(' ')}`);
    this.spawnOptions.push(options);
    const proc = new ManualProc();
    this.procs.push(proc);
    return proc;
  }
}

class ManualProc implements ResumingProc {
  /** Everything written to stdin (the task frame). */
  readonly written: string[] = [];
  readonly stdin: Writable = new Writable({
    write: (chunk, _encoding, callback) => {
      this.written.push(String(chunk));
      callback();
    },
  });
  readonly stdout: Readable = new Readable({ read() {} });
  readonly stderr: Readable = new Readable({ read() {} });
  readonly pid = 4242;
  exitCode: number | null = null;
  readonly killCalls: NodeJS.Signals[] = [];
  private resolveExit: ((code: number) => void) | undefined;
  private readonly exitPromise = new Promise<number>((resolve) => {
    this.resolveExit = resolve;
  });

  wait(): Promise<number> {
    return this.exitPromise;
  }

  async kill(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    this.killCalls.push(signal);
  }

  /** Test driver: make the process exit with `code`. */
  finish(code: number): void {
    this.exitCode = code;
    this.resolveExit?.(code);
  }
}

/**
 * A hand-rolled env over REAL bash and a real temp dir, recording every
 * spawn/fs event — the wrapper's bash side must see the commit flags and
 * snapshot files as real files, so the fs cannot be purely in-memory. The
 * spawn delegates to the production {@link LocalResumingShellEnv}; only the
 * recording wrapper around it is "fake".
 */
class RealEnv implements ResumingShellEnv {
  readonly facts: ResumingShellFacts;
  readonly fs: ResumingShellFs;
  readonly ops: string[] = [];
  /** `spawn`/`exit` timestamps, for serialization / standby assertions. */
  readonly events: Array<{ kind: 'spawn' | 'exit'; at: number; pid?: number }> = [];
  private readonly inner: LocalResumingShellEnv;

  constructor() {
    this.inner = new LocalResumingShellEnv();
    this.facts = this.inner.facts;
    this.fs = {
      readText: (path) => readFile(path, 'utf8'),
      writeText: async (path, text) => {
        this.ops.push(`writeText ${path}`);
        await writeFile(path, text);
      },
      mkdir: async (path) => {
        this.ops.push(`mkdir ${path}`);
        await mkdir(path, { recursive: true });
      },
      remove: async (path) => {
        this.ops.push(`remove ${path}`);
        await rm(path, { force: true });
      },
      exists: async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  async spawn(
    args: readonly string[],
    options?: ResumingShellSpawnOptions,
  ): Promise<ResumingProc> {
    const proc = await this.inner.spawn(args, options);
    this.events.push({ kind: 'spawn', at: Date.now(), pid: proc.pid });
    return {
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      pid: proc.pid,
      exitCode: proc.exitCode,
      wait: async () => {
        const code = await proc.wait();
        this.events.push({ kind: 'exit', at: Date.now(), pid: proc.pid });
        return code;
      },
      kill: (signal?: NodeJS.Signals) => proc.kill(signal),
    };
  }
}

// The real-bash suite runs when a bash is reachable (Git Bash on Windows).
const bashPath: string | undefined = await detectBashPath();

async function detectBashPath(): Promise<string | undefined> {
  let path: string | undefined;
  try {
    path = (await detectEnvironmentFromNode()).shellPath;
  } catch {
    return undefined;
  }
  const probe = await new Promise<boolean>((resolve) => {
    const child = spawn(path, ['-c', 'exit 0'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 10_000);
    timer.unref?.();
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
  return probe ? path : undefined;
}

const tempDirs: string[] = [];
const liveShells: ResumingShell[] = [];
async function makeRealShell(): Promise<{
  shell: ResumingShell;
  env: RealEnv;
  dir: string;
  snap: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-resuming-'));
  tempDirs.push(dir);
  const env = new RealEnv();
  const snap = join(dir, 'snap');
  const shell = new ResumingShell(env, {
    snapshotDir: snap,
    initialCwd: dir,
    shellPath: bashPath,
  });
  liveShells.push(shell);
  return { shell, env, dir, snap };
}

afterAll(async () => {
  // Dispose first: every settled fg task pre-spawns an idle standby wrapper
  // (a real bash blocked on the frame read) — leaving one behind would both
  // leak the process and pin its cwd temp dir on Windows.
  await Promise.all(liveShells.map((shell) => shell.dispose().catch(() => {})));
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

// ── (a) script-template invariants ────────────────────────────────────────

describe('buildResumingWrapperScript', () => {
  // The script is task-AGNOSTIC: id / fg / cwd / command all ride the stdin
  // frame, so one template serves every task AND the pre-spawned standby.
  const script = buildResumingWrapperScript({
    snapshotDir: '/s/snap',
    initialCwd: '/s',
  });

  it('defines the dump / absorb / state-note machinery', () => {
    expect(script).toContain('__kimi_dump_state()');
    expect(script).toContain('__kimi_absorb()');
    expect(script).toContain('__kimi_state_note()');
    expect(script).toContain('__kimi_task_exit()');
    expect(script).toContain('__KIMI_KEEPVARS_RE');
    expect(script).toContain("printf '[bash state] replay failed (%s)");
  });

  it('blocks on the single stdin frame between preamble and hand-off', () => {
    expect(script).toContain(
      "IFS=$'\\t' read -r __KIMI_TASK_ID __KIMI_FG __KIMI_CWDB64 __KIMI_CMDB64 || exit 0",
    );
    // The frame read happens AFTER the absorb (preamble) and BEFORE the
    // EXIT trap / eval (hand-off).
    const absorb = script.indexOf('__kimi_absorb "$__KIMI_SNAP" 2>');
    const frameRead = script.indexOf('read -r __KIMI_TASK_ID');
    const trap = script.indexOf("trap '__kimi_task_exit \"$?\"' EXIT");
    const evalCmd = script.indexOf('eval "$(printf');
    expect(absorb).toBeGreaterThanOrEqual(0);
    expect(frameRead).toBeGreaterThan(absorb);
    expect(trap).toBeGreaterThan(frameRead);
    expect(evalCmd).toBeGreaterThan(trap);
  });

  it('carries nothing task-specific: id / fg / cwd / command come from the frame', () => {
    expect(script).not.toContain('__KIMI_TASK_ID=');
    expect(script).not.toContain('__KIMI_FG=');
    expect(script).not.toContain('__KIMI_CMDB64=');
    expect(script).not.toContain('__KIMI_TOOL_CWD=/');
    // `-` marks an absent tool cwd; base64 is decoded only when present.
    expect(script).toContain('[[ "$__KIMI_CWDB64" != \'-\' ]]');
    // The paths that ARE baked in are the per-shell constants, shell-quoted.
    expect(script).toContain("__KIMI_SNAPDIR='/s/snap'");
    expect(script).toContain("__KIMI_INITIAL_CWD='/s'");
  });

  it('gates the commit on the EXIT trap, the frame-carried flag, and exit code 0', () => {
    expect(script).toContain("trap '__kimi_task_exit \"$?\"' EXIT");
    expect(script).toContain('"$__KIMI_SNAPDIR/$__KIMI_TASK_ID.commit-ok"');
    expect(script).toContain('"$__kimi_ec" -eq 0');
    expect(script).toContain('[[ "$__KIMI_FG" == "1" && -f');
    // The commit writes the three-file snapshot via atomic tmp+rename, with
    // the no-op skip done by a builtin string compare (no cmp/rm spawns).
    expect(script).toContain('"$__KIMI_SNAP.$__kimi_f.tmp"');
    expect(script).toContain('mv -f');
    expect(script).not.toContain('cmp -s');
  });

  it('does not carry over the fork-protocol machinery', () => {
    expect(script).not.toContain('__KIMI_TASK__');
    expect(script).not.toContain('__KIMI_PING__');
    expect(script).not.toContain('__KIMI_PONG__');
    expect(script).not.toContain('__KIMI_REAPED__');
    expect(script).not.toContain('detach-');
    expect(script).not.toContain('.out');
    // The old tip's frame-reading loop is gone (the state-note's name-diff
    // loop is a different, legitimate `while IFS= read`; the hand-off read
    // and the restore-err first-line read use different variable names).
    expect(script).not.toContain('read -r __kimi_line');
  });

  it('gates the fg-only sections (sweep, pre-state, commit) on the frame', () => {
    // One script serves bg and fg; the difference is the frame's FG field.
    expect(script).toContain('__kimi_absorb');
    expect(script).toContain("trap '__kimi_task_exit \"$?\"' EXIT");
    const fgGates = script.match(/\[\[ "\$__KIMI_FG" == "1" \]\]/g) ?? [];
    // stale sweep + pre-state capture (+ the commit gate, which uses &&).
    expect(fgGates.length).toBeGreaterThanOrEqual(2);
  });
});

// ── (b) TS-side behavior on the fake env ──────────────────────────────────

describe('ResumingShell (fake env)', () => {
  const snapshotDir = join('/tmp', 'snap');
  const flagOf = (id: string): string => join(snapshotDir, `${id}.commit-ok`);

  it('serializes foreground tasks through the per-shell mutex', async () => {
    const env = new ManualEnv();
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/tmp' });
    const first = await shell.runTask({ id: 'a', command: 'true', background: false });
    expect(env.procs).toHaveLength(1);

    const second = shell.runTask({ id: 'b', command: 'true', background: false });
    await Promise.resolve();
    // b must not have spawned while a holds the fg slot.
    expect(env.procs).toHaveLength(1);

    env.procs[0]!.finish(0);
    await second;
    expect(env.procs).toHaveLength(2);
    // The fg flag was created before the first spawn (the cold path).
    const firstSpawn = env.ops.findIndex((op) => op.startsWith('spawn '));
    expect(firstSpawn).toBeGreaterThanOrEqual(0);
    expect(env.ops.indexOf('writeText ' + flagOf('a'))).toBeLessThan(firstSpawn);
  });

  it('spawns the wrapper at initialCwd and retries inherited when it vanished', async () => {
    const env = new ManualEnv();
    env.dirs.add('/wd');
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/wd' });
    const task = await shell.runTask({ id: 'a', command: 'true', background: false });
    expect(env.spawnOptions[0]?.cwd).toBe('/wd');
    env.procs[0]!.finish(0);
    await task.wait();

    // A vanished workdir kills the spawn with a raw ENOENT: the retry runs
    // with an inherited cwd so the wrapper's own cd reports the real path.
    const goneEnv = new ManualEnv();
    let firstCwd: string | undefined;
    const baseSpawn = goneEnv.spawn.bind(goneEnv);
    goneEnv.spawn = async (args, options) => {
      firstCwd ??= options?.cwd;
      if (options?.cwd === '/gone') throw new Error('spawn bash ENOENT');
      return baseSpawn(args, options);
    };
    const goneShell = new ResumingShell(goneEnv, { snapshotDir, initialCwd: '/gone' });
    const goneTask = await goneShell.runTask({ id: 'b', command: 'true', background: false });
    expect(firstCwd).toBe('/gone');
    // The failed attempt never reached the recording base spawn; the retry
    // is the only recorded proc, with an inherited cwd.
    expect(goneEnv.spawnOptions).toHaveLength(1);
    expect(goneEnv.spawnOptions[0]?.cwd).toBeUndefined();
    goneEnv.procs[0]!.finish(0);
    await goneTask.wait();
  });

  it('lets background tasks spawn without waiting for the fg slot', async () => {
    const env = new ManualEnv();
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/tmp' });
    await shell.runTask({ id: 'a', command: 'sleep 9', background: false });
    const bg = shell.runTask({ id: 'b', command: 'true', background: true });
    await bg;
    expect(env.procs).toHaveLength(2);
    expect(env.ops).not.toContain('writeText ' + flagOf('b'));
  });

  it('creates the commit flag only for foreground tasks', async () => {
    const env = new ManualEnv();
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/tmp' });
    const fg = await shell.runTask({ id: 'f', command: 'true', background: false });
    expect(await env.fs.exists(flagOf('f'))).toBe(true);
    const bg = await shell.runTask({ id: 'g', command: 'true', background: true });
    expect(await env.fs.exists(flagOf('g'))).toBe(false);
    env.procs[0]!.finish(0);
    env.procs[1]!.finish(0);
    await fg.wait();
    await bg.wait();
  });

  it('detach removes the flag before the process can exit-commit', async () => {
    const env = new ManualEnv();
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/tmp' });
    const task = await shell.runTask({ id: 'd', command: 'true', background: false });
    expect(await env.fs.exists(flagOf('d'))).toBe(true);
    await task.detach();
    expect(await env.fs.exists(flagOf('d'))).toBe(false);
    // The fg slot is freed by the detach: a new fg task spawns immediately.
    const next = shell.runTask({ id: 'e', command: 'true', background: false });
    await next;
    expect(env.procs).toHaveLength(2);
    env.procs[0]!.finish(0);
    env.procs[1]!.finish(0);
    await task.wait();
    await next;
  });

  it('kill removes the flag first, then kills the process', async () => {
    const env = new ManualEnv();
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/tmp' });
    const task = await shell.runTask({ id: 'k', command: 'true', background: false });
    await task.kill();
    expect(await env.fs.exists(flagOf('k'))).toBe(false);
    expect(env.procs[0]!.killCalls).toEqual(['SIGTERM']);
    const removeAt = env.ops.indexOf('remove ' + flagOf('k'));
    expect(removeAt).toBeGreaterThanOrEqual(0);
    env.procs[0]!.finish(143);
    await task.wait();
  });

  it('rejects runTask failures without leaking the fg slot or the flag', async () => {
    const env = new ManualEnv();
    // The workdir exists, so the spawn-cwd fallback never engages: the
    // original spawn error propagates.
    env.dirs.add('/tmp');
    let spawnCalls = 0;
    const failing: ResumingShellEnv = {
      facts: env.facts,
      fs: env.fs,
      async spawn() {
        spawnCalls++;
        if (spawnCalls === 1) throw new Error('spawn failed');
        return env.spawn([]);
      },
    };
    const shell = new ResumingShell(failing, { snapshotDir, initialCwd: '/tmp' });
    await expect(shell.runTask({ id: 'x', command: 'true', background: false })).rejects.toThrow(
      'spawn failed',
    );
    expect(await env.fs.exists(flagOf('x'))).toBe(false);
    // The mutex must not be wedged: a later task can still acquire it.
    const ok = await shell.runTask({ id: 'y', command: 'true', background: false });
    env.procs[0]!.finish(0);
    await ok.wait();
  });
});

// ── (b′) standby lifecycle on the fake env ────────────────────────────────

describe('ResumingShell standby (fake env)', () => {
  const snapshotDir = join('/tmp', 'snap');
  const flagOf = (id: string): string => join(snapshotDir, `${id}.commit-ok`);
  /** Drain pending microtasks so the settle → replenish chain lands. */
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
  };
  const frameOf = (proc: ManualProc): string => proc.written.join('');

  it('hands the next task to the standby and replenishes it after a 0-exit fg task', async () => {
    const env = new ManualEnv();
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/tmp' });
    const t1 = await shell.runTask({ id: 'w1', command: 'true', background: false });
    expect(env.procs).toHaveLength(1); // cold: no standby exists yet
    env.procs[0]!.finish(0);
    await t1.wait();
    await flush();
    // The settle spawned exactly ONE new process: the replacement standby.
    expect(env.procs).toHaveLength(2);
    const standby = env.procs[1]!;
    expect(standby.written).toEqual([]); // no frame yet — it idles pre-handoff

    const t2 = await shell.runTask({ id: 'w2', command: 'echo hi', background: false });
    // The task consumed the standby: NO task spawn happened.
    expect(env.procs).toHaveLength(2);
    expect(standby.killCalls).toEqual([]);
    // …and it got exactly the one frame line: id, fg, `-` cwd, base64 cmd.
    expect(frameOf(standby)).toBe(
      `w2\t1\t-\t${Buffer.from('echo hi', 'utf8').toString('base64')}\n`,
    );
    // The commit flag was written before the frame reached the process.
    expect(env.ops.indexOf('writeText ' + flagOf('w2'))).toBeGreaterThanOrEqual(0);

    standby.finish(0);
    await t2.wait();
    await flush();
    // Again: at most the replenishment spawn, never a task spawn.
    expect(env.procs).toHaveLength(3);
    const t3 = await shell.runTask({ id: 'w3', command: 'true', cwd: '/etc', background: false });
    expect(env.procs).toHaveLength(3);
    expect(frameOf(env.procs[2]!)).toBe(
      `w3\t1\t${Buffer.from('/etc', 'utf8').toString('base64')}\t${Buffer.from('true', 'utf8').toString('base64')}\n`,
    );
    env.procs[2]!.finish(0);
    await t3.wait();
  });

  it('replaces an idle standby at a 0-exit settle and keeps it on a non-zero one', async () => {
    const env = new ManualEnv();
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/tmp' });
    // Construct an idle standby WHILE an fg task runs: a detached task that
    // exits 0 cannot have committed (its flag is gone), but its settle still
    // pre-spawns a standby; the running fg task's own settle then decides.
    const t1 = await shell.runTask({ id: 'i1', command: 'x', background: false });
    await t1.detach();
    const t2 = await shell.runTask({ id: 'i2', command: 'x', background: false });
    expect(env.procs).toHaveLength(2);
    env.procs[0]!.finish(0); // t1 (detached) settles 0 → replenish
    await t1.wait();
    await flush();
    expect(env.procs).toHaveLength(3);
    const s1 = env.procs[2]!;

    // Non-zero fg settle (rollback — the snapshot is untouched): the idle
    // standby stays valid, so it is neither killed nor replaced…
    env.procs[1]!.finish(1);
    await t2.wait();
    await flush();
    expect(env.procs).toHaveLength(3);
    expect(s1.killCalls).toEqual([]);
    // …and it serves the next task.
    const t3 = await shell.runTask({ id: 'i3', command: 'x', background: false });
    expect(env.procs).toHaveLength(3);
    s1.finish(0);
    await t3.wait();
    await flush();
    const s2 = env.procs[3]!;

    // 0-exit fg settle (commit or no-op commit): a fresh standby replaces
    // any idle one — but the consumed-standby case means none is idle here,
    // so only the replenishment spawn happens.
    expect(env.procs).toHaveLength(4);
    const t4 = await shell.runTask({ id: 'i4', command: 'x', background: false });
    expect(env.procs).toHaveLength(4);
    s2.finish(0);
    await t4.wait();
    await flush();
    expect(env.procs).toHaveLength(5);

    // Idle-at-settle replacement: while t5 (consuming the newest standby)
    // runs, another detached-style replenish… is covered above; here assert
    // the simplest form: kill the shell's leftover state cleanly.
    const t5 = await shell.runTask({ id: 'i5', command: 'x', background: false });
    env.procs[4]!.finish(0);
    await t5.wait();
  });

  it('kills the idle standby when a 0-exit settle replaces it', async () => {
    const env = new ManualEnv();
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/tmp' });
    // t1 detached + t2 fg gives an idle standby while t2 runs (see above);
    // t2's 0-exit settle must KILL that standby (it absorbed the pre-t2
    // snapshot) and spawn a fresh one.
    const t1 = await shell.runTask({ id: 'r1', command: 'x', background: false });
    await t1.detach();
    const t2 = await shell.runTask({ id: 'r2', command: 'x', background: false });
    env.procs[0]!.finish(0);
    await t1.wait();
    await flush();
    expect(env.procs).toHaveLength(3);
    const staleStandby = env.procs[2]!;
    env.procs[1]!.finish(0); // t2 commits → replace the idle standby
    await t2.wait();
    await flush();
    expect(env.procs).toHaveLength(4); // the fresh standby
    expect(staleStandby.killCalls).toEqual(['SIGTERM']);
  });

  it('replenishes immediately when a bg task consumes the standby', async () => {
    const env = new ManualEnv();
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/tmp' });
    const t1 = await shell.runTask({ id: 'c1', command: 'true', background: false });
    env.procs[0]!.finish(0);
    await t1.wait();
    await flush();
    expect(env.procs).toHaveLength(2); // the standby

    const bg = await shell.runTask({ id: 'c2', command: 'true', background: true });
    // bg never commits → the replacement is spawned right at hand-off: by
    // the time runTask resolves, the consumed standby AND its replacement
    // are both visible (no settle wait, no flush needed).
    expect(env.procs).toHaveLength(3);
    // …and the bg task got a frame with fg=0 and no commit flag.
    expect(frameOf(env.procs[1]!)).toBe(
      `c2\t0\t-\t${Buffer.from('true', 'utf8').toString('base64')}\n`,
    );
    expect(await env.fs.exists(flagOf('c2'))).toBe(false);
    env.procs[1]!.finish(0);
    await bg.wait();
  });

  it('falls back to an on-demand spawn when the standby died before use', async () => {
    const env = new ManualEnv();
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/tmp' });
    const t1 = await shell.runTask({ id: 'd1', command: 'true', background: false });
    env.procs[0]!.finish(0);
    await t1.wait();
    await flush();
    expect(env.procs).toHaveLength(2);
    env.procs[1]!.finish(1); // the standby dies mid-preamble
    await flush();

    const t2 = await shell.runTask({ id: 'd2', command: 'true', background: false });
    // The dead standby was discarded and the task spawned on demand.
    expect(env.procs).toHaveLength(3);
    expect(frameOf(env.procs[2]!)).toContain('d2\t1\t');
    // The dead standby's script file is cleaned up (best-effort; the
    // discard chain lands a few microtasks after the cold path).
    await flush();
    expect(env.ops).toContain(`remove ${join(snapshotDir, 'wrappers', 'standby-1.sh')}`);
    env.procs[2]!.finish(0);
    await t2.wait();
  });

  it('dispose kills every live task AND the idle standby', async () => {
    const env = new ManualEnv();
    const shell = new ResumingShell(env, { snapshotDir, initialCwd: '/tmp' });
    const t1 = await shell.runTask({ id: 'x1', command: 'true', background: false });
    env.procs[0]!.finish(0);
    await t1.wait();
    await flush();
    expect(env.procs).toHaveLength(2); // the idle standby
    const bg = await shell.runTask({ id: 'x2', command: 'sleep 9', background: true });
    await flush();
    expect(env.procs).toHaveLength(3); // consumed standby + its replacement

    await shell.dispose();
    expect(env.procs[1]!.killCalls).toEqual(['SIGTERM']); // the live bg task
    expect(env.procs[2]!.killCalls).toEqual(['SIGTERM']); // the idle standby
    env.procs[1]!.finish(143);
    await bg.wait();
  });
});

// ── (b)+(c) real-bash semantics ───────────────────────────────────────────

describe.skipIf(bashPath === undefined)('ResumingShell (real bash)', () => {
  it('commits a successful fg task as the three-file snapshot', async () => {
    const { shell, snap } = await makeRealShell();
    const task = await shell.runTask({
      id: 'c1',
      command: 'export FG_VAR=hello; f1() { :; }',
      background: false,
    });
    expect(await task.wait()).toBe(0);
    const state = await readFile(join(snap, 'shell-state.state'), 'utf8');
    expect(state).toContain('FG_VAR="hello"');
    expect(state).toContain('f1 ()');
    const vars = await readFile(join(snap, 'shell-state.vars'), 'utf8');
    expect(vars.split('\n')).toContain('FG_VAR');
    const funcs = await readFile(join(snap, 'shell-state.funcs'), 'utf8');
    expect(funcs.split('\n')).toContain('f1');
    // The wrapper removed its own flag on exit.
    await expect(access(join(snap, 'c1.commit-ok'))).rejects.toThrow();
  }, 60_000);

  it('rolls back on a non-zero exit (snapshot unchanged)', async () => {
    const { shell, snap } = await makeRealShell();
    const first = await shell.runTask({ id: 'r1', command: 'export ROLL_VAR=1', background: false });
    expect(await first.wait()).toBe(0);
    const statePath = join(snap, 'shell-state.state');
    const before = await readFile(statePath, 'utf8');

    const failing = await shell.runTask({
      id: 'r2',
      command: 'export ROLL_VAR=2; exit 7',
      background: false,
    });
    expect(await failing.wait()).toBe(7);
    const after = await readFile(statePath, 'utf8');
    expect(after).toBe(before);
    expect(after).toContain('ROLL_VAR="1"');
    expect(after).not.toContain('ROLL_VAR="2"');
  }, 60_000);

  it('never commits background tasks', async () => {
    const { shell, snap } = await makeRealShell();
    await (await shell.runTask({ id: 'g0', command: 'true', background: false })).wait();
    const bg = await shell.runTask({ id: 'g1', command: 'export BG_VAR=1', background: true });
    expect(await bg.wait()).toBe(0);
    const state = await readFile(join(snap, 'shell-state.state'), 'utf8');
    expect(state).not.toContain('BG_VAR');
    await expect(access(join(snap, 'g1.commit-ok'))).rejects.toThrow();
  }, 60_000);

  it('detach before exit prevents the commit', async () => {
    const { shell, snap } = await makeRealShell();
    await (await shell.runTask({ id: 'd0', command: 'true', background: false })).wait();
    const task = await shell.runTask({
      id: 'd1',
      command: 'sleep 0.3 && export DET_VAR=1',
      background: false,
    });
    await task.detach();
    expect(await task.wait()).toBe(0);
    const state = await readFile(join(snap, 'shell-state.state'), 'utf8');
    expect(state).not.toContain('DET_VAR');
  }, 60_000);

  it('kill prevents the commit and reports a non-zero exit', async () => {
    const { shell, snap } = await makeRealShell();
    await (await shell.runTask({ id: 'k0', command: 'true', background: false })).wait();
    const task = await shell.runTask({
      id: 'k1',
      command: 'sleep 5 && export KILL_VAR=1',
      background: false,
    });
    await task.kill();
    expect(await task.wait()).not.toBe(0);
    const state = await readFile(join(snap, 'shell-state.state'), 'utf8');
    expect(state).not.toContain('KILL_VAR');
  }, 60_000);

  it('keeps the durable snapshot byte-identical (mtime untouched) on no-op commits', async () => {
    const { shell, snap } = await makeRealShell();
    const statePath = join(snap, 'shell-state.state');
    const commit = await shell.runTask({ id: 'm1', command: 'export MTIME_VAR=1', background: false });
    expect(await commit.wait()).toBe(0);
    const mtime1 = (await stat(statePath)).mtimeMs;

    const noop = await shell.runTask({ id: 'm2', command: 'true', background: false });
    expect(await noop.wait()).toBe(0);
    const mtime2 = (await stat(statePath)).mtimeMs;
    expect(mtime2).toBe(mtime1);

    const change = await shell.runTask({ id: 'm3', command: 'export MTIME_VAR=2', background: false });
    expect(await change.wait()).toBe(0);
    const mtime3 = (await stat(statePath)).mtimeMs;
    expect(mtime3).toBeGreaterThan(mtime1);
  }, 60_000);

  it('sweeps stale commit flags on the next fg run (bg leaves them alone)', async () => {
    const { shell, snap } = await makeRealShell();
    await mkdir(snap, { recursive: true });
    const stale = join(snap, 'stale.commit-ok');
    await writeFile(stale, '');
    const fg = await shell.runTask({ id: 's1', command: 'true', background: false });
    expect(await fg.wait()).toBe(0);
    await expect(access(stale)).rejects.toThrow();

    const stale2 = join(snap, 'stale2.commit-ok');
    await writeFile(stale2, '');
    const bg = await shell.runTask({ id: 's2', command: 'true', background: true });
    expect(await bg.wait()).toBe(0);
    await expect(access(stale2)).resolves.toBeUndefined();
  }, 60_000);

  it('serializes two concurrent fg tasks end to end', async () => {
    const { shell, env } = await makeRealShell();
    const a = shell.runTask({ id: 'm-a', command: 'sleep 0.3', background: false });
    const b = shell.runTask({ id: 'm-b', command: 'sleep 0.3', background: false });
    const [codeA, codeB] = await Promise.all([(await a).wait(), (await b).wait()]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    const events = env.events;
    const spawnA = events.findIndex((e) => e.kind === 'spawn');
    const exitA = events.findIndex((e, i) => i > spawnA && e.kind === 'exit');
    const spawnB = events.findIndex((e, i) => i > exitA && e.kind === 'spawn');
    expect(spawnA).toBeGreaterThanOrEqual(0);
    expect(exitA).toBeGreaterThan(spawnA);
    // b's process started only after a's process exited (and committed).
    expect(spawnB).toBeGreaterThan(exitA);
  }, 60_000);

  it('restores cwd and exported vars in a fresh shell (session resume smoke)', async () => {
    const { shell: first, dir, snap } = await makeRealShell();
    let stderr1 = '';
    const r1 = await first.runTask({
      id: 'z1',
      command: 'mkdir -p sub && cd sub && export FOO=1',
      background: false,
    });
    r1.stderr.on('data', (chunk: Buffer) => (stderr1 += chunk.toString('utf8')));
    expect(await r1.wait()).toBe(0);
    // The commit printed the [bash state] note (names only) on stderr; cwd
    // changes are deliberately never reported.
    expect(stderr1).toContain('[bash state]');
    expect(stderr1).toContain('env: +FOO');
    expect(stderr1).not.toContain('cwd=');

    // "Close" the shell: a brand-new instance over the same snapshot dir
    // restores the committed cwd and environment.
    const env2 = new RealEnv();
    const second = new ResumingShell(env2, { snapshotDir: snap, initialCwd: dir, shellPath: bashPath });
    let out = '';
    const r2 = await second.runTask({
      id: 'z2',
      command: 'printf "%s|%s" "$PWD" "$FOO"',
      background: false,
    });
    r2.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    expect(await r2.wait()).toBe(0);
    expect(out.trim()).toMatch(/\/sub\|1$/);
  }, 60_000);

  it('runs sequenced commands on pre-warmed standbys (spawn = replenish only)', async () => {
    const { shell, env } = await makeRealShell();
    // 3 sequenced commands: export a var, cd, verify both — tasks 2 and 3
    // must be handed to the standby spawned by the previous task's settle
    // (pid-chain: the first spawn after task N's exit IS task N+1's proc).
    const c1 = await shell.runTask({ id: 'q1', command: 'export SEQ_VAR=42', background: false });
    expect(await c1.wait()).toBe(0);
    const c2 = await shell.runTask({
      id: 'q2',
      command: 'mkdir -p qsub && cd qsub',
      background: false,
    });
    expect(await c2.wait()).toBe(0);
    let out = '';
    const c3 = await shell.runTask({
      id: 'q3',
      command: 'printf "%s|%s" "$SEQ_VAR" "$PWD"',
      background: false,
    });
    c3.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    expect(await c3.wait()).toBe(0);
    expect(out.trim()).toMatch(/42\|.+\/qsub$/);

    const spawnAfter = (pid: number): { pid?: number } | undefined => {
      const exitIdx = env.events.findIndex((e) => e.kind === 'exit' && e.pid === pid);
      return env.events.slice(exitIdx + 1).find((e) => e.kind === 'spawn');
    };
    // c2's process is the standby spawned right after c1 exited; same c2→c3.
    expect(c2.pid).toBe(spawnAfter(c1.pid)?.pid);
    expect(c3.pid).toBe(spawnAfter(c2.pid)?.pid);
    await shell.dispose();
  }, 60_000);
});
