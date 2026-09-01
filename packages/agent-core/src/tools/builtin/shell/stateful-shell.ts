/**
 * StatefulShell (v1 adapter) — a thin per-agent wrapper over
 * @moonshot-ai/kaos's `ResumingShell` core (`packages/kaos/src/stateful-shell/
 * resuming.ts`): one FRESH bash process per command whose in-memory state
 * (variables incl. unexported ones, functions incl. conda activation, cwd,
 * umask) is restored from a durable snapshot before the command and committed
 * back after each successful foreground command. There is no persistent shell
 * process anymore — every task is a direct child of the execution
 * environment, and state durability lives entirely in the snapshot files.
 *
 * This module owns only the v1 constructor shape —
 * `new StatefulShell(initialCwd, snapshotDir)` — and adapts the kaos task
 * handle to the `KaosProcess` surface the v1 tool pipeline
 * (`ProcessBackgroundTask` / `BackgroundManager`) consumes. The snapshot-dir
 * derivation (the agent home) stays with the caller in `agent/tool/index.ts`.
 *
 * It also owns `seedShellStateSnapshot`, the one-time creation-time copy of a
 * parent agent's committed snapshot (`shell-state.{state,vars,funcs}`) into a
 * freshly created child agent's own `shell-state` dir, so the child's first
 * Bash call starts from the parent's committed state instead of cold. After
 * the copy the two snapshots are fully independent; a parent without a
 * snapshot is a no-op (the child dir is NOT created).
 */

import { copyFile, mkdir, stat } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';

import {
  type KaosProcess,
  LocalResumingShellEnv,
  ResumingShell,
  type ResumingShellProcess,
} from '@moonshot-ai/kaos';
import { join } from 'pathe';

const SNAPSHOT_FILES = ['shell-state.state', 'shell-state.vars', 'shell-state.funcs'] as const;

/**
 * Copy the parent's committed resuming-shell snapshot into the child's own
 * `shell-state` dir. Pure copy — the caller owns the best-effort policy.
 */
export async function seedShellStateSnapshot(
  parentHomedir: string,
  childHomedir: string,
): Promise<void> {
  const parentDir = join(parentHomedir, 'shell-state');
  const existing: string[] = [];
  for (const name of SNAPSHOT_FILES) {
    try {
      await stat(join(parentDir, name));
      existing.push(name);
    } catch {
      // Missing snapshot file — skip it.
    }
  }
  if (existing.length === 0) return;
  const childDir = join(childHomedir, 'shell-state');
  await mkdir(childDir, { recursive: true });
  for (const name of existing) {
    await copyFile(join(parentDir, name), join(childDir, name));
  }
}

export interface StatefulShellRunInput {
  readonly command: string;
  /** Tool-requested cwd; when omitted the command runs at the restored cwd. */
  readonly cwd?: string;
  /** Background tasks restore read-only and never commit their changes. */
  readonly background: boolean;
}

/**
 * One stateful shell (per agent), backed by a `ResumingShell` running on
 * {@link LocalResumingShellEnv}. Foreground tasks run strictly serialized
 * (the shell's fg mutex), background tasks run unserialized and never commit.
 */
export class StatefulShell {
  private readonly shell: ResumingShell;
  private taskSeq = 0;

  constructor(initialCwd: string, snapshotDir: string) {
    this.shell = new ResumingShell(new LocalResumingShellEnv(), {
      snapshotDir,
      initialCwd,
    });
  }

  async runTask(input: StatefulShellRunInput): Promise<StatefulShellProcess> {
    const id = this.nextTaskId();
    const handle = await this.shell.runTask({ id, ...input });
    return new StatefulShellProcess(handle);
  }

  /** Kill every live task AND the idle standby (session close / feature off). */
  async dispose(): Promise<void> {
    await this.shell.dispose();
  }

  private nextTaskId(): string {
    this.taskSeq += 1;
    return `stateful-${Date.now().toString(36)}-${this.taskSeq.toString(36)}`;
  }
}

/**
 * The kaos task handle adapted to `KaosProcess` so the rest of the v1
 * pipeline (ProcessBackgroundTask / BackgroundManager) treats a stateful task
 * exactly like a one-shot spawn. `kill`/`detach` route through the shell's
 * commit-flag lifecycle: the flag is removed BEFORE the process can
 * exit-commit, so a killed or backgrounded task never writes state.
 */
export class StatefulShellProcess implements KaosProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  private _exitCode: number | null = null;

  constructor(private readonly handle: ResumingShellProcess) {
    this.stdin = handle.stdin;
    this.stdout = handle.stdout;
    this.stderr = handle.stderr;
  }

  get pid(): number {
    return this.handle.pid;
  }

  get exitCode(): number | null {
    return this.handle.exitCode ?? this._exitCode;
  }

  wait(): Promise<number> {
    return this.handle.wait().then((code) => {
      this._exitCode = code;
      return code;
    });
  }

  kill(): Promise<void> {
    return this.handle.kill();
  }

  /** Downgrade a foreground task to background semantics (fg timeout / ctrl+b). */
  detach(): Promise<void> {
    return this.handle.detach();
  }

  /** The wrapper process is a direct child; streams close when it exits. */
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
