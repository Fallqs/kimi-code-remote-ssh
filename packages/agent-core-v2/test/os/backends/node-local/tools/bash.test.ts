import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, type Writable } from 'node:stream';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { createScopedTestHost, createServices, stubPair } from '#/_base/di/test';
import { probeHostEnvironmentFromNode } from '#/_base/execEnv/environmentProbe';
import {
  IAgentTaskService,
  type AgentTask,
  type AgentTaskInfo,
  type AgentTaskOutputSnapshot,
  type AgentTaskStatus,
  type ForegroundTaskReleaseReason,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import type { AgentTaskSettlement } from '#/agent/task/types';
import { userCancellationReason } from '#/_base/utils/abort';
import type { IConfigService } from '#/app/config/config';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { stubWorkspaceContext } from '../../../../session/workspaceContext/stub-workspace-context';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { type IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { type BashInput, BashInputSchema, type BashRunInput } from '#/agent/tools/os/bash/bash';
import { BashTool } from '#/agent/tools/os/bash/bashTool';
import {
  IAgentStatefulShell,
  type StatefulShellProcess,
  type StatefulShellRunInput,
} from '#/agent/tools/os/bash/statefulShell';
import { AgentStatefulShellService } from '#/agent/tools/os/bash/statefulShellService';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const posixEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'arm64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  ready: Promise.resolve(),
};

const windowsBashEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: 'test',
  shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  shellName: 'bash',
  pathClass: 'win32',
  homeDir: 'C:\\Users\\test',
  ready: Promise.resolve(),
};

function processWithOutput(
  options: {
    readonly stdout?: string | Buffer;
    readonly stderr?: string | Buffer;
    readonly exitCode?: number | null;
    readonly wait?: () => Promise<number>;
    readonly kill?: (signal?: NodeJS.Signals) => Promise<void>;
  } = {},
): IHostProcess {
  const exitCode = options.exitCode ?? 0;
  const stdout = Readable.from(options.stdout === undefined ? [] : [options.stdout]);
  const stderr = Readable.from(options.stderr === undefined ? [] : [options.stderr]);
  return {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 123,
    exitCode,
    wait: vi.fn(options.wait ?? (async () => exitCode)),
    kill: vi.fn(options.kill ?? (async () => {})),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function processWithInterleavedOutput(
  events: ReadonlyArray<{
    readonly stream: 'stdout' | 'stderr';
    readonly text: string;
    readonly delayMs: number;
  }>,
  exitCode = 0,
): IHostProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lastDelay = Math.max(...events.map((event) => event.delayMs), 0);
  const waitPromise = new Promise<number>((resolve) => {
    for (const event of events) {
      setTimeout(() => {
        const target = event.stream === 'stdout' ? stdout : stderr;
        target.write(event.text);
      }, event.delayMs);
    }
    setTimeout(() => {
      stdout.end();
      stderr.end();
      resolve(exitCode);
    }, lastDelay + 1);
  });

  return {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 124,
    exitCode,
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function pendingProcess(): {
  readonly proc: IHostProcess;
  readonly finish: (exitCode?: number) => void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveWait: (exitCode: number) => void = () => {};
  let currentExitCode: number | null = null;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const finish = (exitCode = 0): void => {
    if (currentExitCode !== null) return;
    currentExitCode = exitCode;
    stdout.end();
    stderr.end();
    resolveWait(exitCode);
  };
  return {
    proc: {
      _serviceBrand: undefined,
      stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
      stdout,
      stderr,
      pid: 125,
      get exitCode(): number | null {
        return currentExitCode;
      },
      wait: vi.fn(async () => waitPromise),
      kill: vi.fn(async () => {
        finish(143);
      }) as IHostProcess['kill'],
      dispose: vi.fn(async () => {}),
    },
    finish,
  };
}

function processWithVisibleExitBeforeWait(exitCode = 0): {
  proc: IHostProcess;
  finishWait: () => void;
  markExited: () => void;
} {
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 125,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };

  return {
    proc,
    finishWait: () => {
      resolveWait(exitCode);
    },
    markExited: () => {
      currentExitCode = exitCode;
    },
  };
}

function processThatNeverExits(): IHostProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 126,
    exitCode: null,
    wait: vi.fn(async () => new Promise<number>(() => {})),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function processWithStreamError(options: {
  readonly stdoutError?: Error;
  readonly stderrError?: Error;
  readonly exitCode?: number;
} = {}): IHostProcess {
  const exitCode = options.exitCode ?? 0;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const waitPromise = new Promise<number>((resolve) => {
    setTimeout(() => {
      if (options.stdoutError !== undefined) {
        stdout.emit('error', options.stdoutError);
      } else {
        stdout.end();
      }
      if (options.stderrError !== undefined) {
        stderr.emit('error', options.stderrError);
      } else {
        stderr.end();
      }
      resolve(exitCode);
    }, 1);
  });
  return {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 128,
    exitCode,
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

function processWithOpenStreamsThatExitOnKill(): IHostProcess {
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  return {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 127,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: vi.fn(async () => waitPromise),
    kill: vi.fn(async () => {
      currentExitCode = 143;
      resolveWait(143);
    }),
    dispose: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function createTestEnv(env: IHostEnvironment = posixEnv): IHostEnvironment {
  return env;
}

function createTestCtx(cwd = '/workspace'): ISessionContext {
  return makeSessionContext({
    sessionId: 's',
    workspaceId: 'w',
    sessionDir: cwd,
    sessionScope: 'sessions/w/s',
    cwd,
  });
}

function createTestRunner(proc: IHostProcess | ReturnType<typeof vi.fn>) {
  const exec = typeof proc === 'function' ? proc : vi.fn().mockResolvedValue(proc);
  const runner = { _serviceBrand: undefined, spawn: exec } as IHostProcessService;
  return { runner, exec };
}

const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);
const SIGTERM_GRACE_MS = 5_000;
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

interface ForegroundRelease {
  readonly promise: Promise<ForegroundTaskReleaseReason>;
  resolve(reason: ForegroundTaskReleaseReason): void;
}

interface ManagedEntry {
  readonly taskId: string;
  readonly task: AgentTask;
  readonly startedDetached: boolean;
  readonly options: RegisterAgentTaskOptions;
  readonly outputChunks: string[];
  readonly abortController: AbortController;
  readonly startedAt: number;
  readonly waiters: Array<() => void>;
  status: AgentTaskStatus;
  stopReason?: string;
  endedAt: number | null;
  foregroundRelease?: ForegroundRelease;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  lifecyclePromise: Promise<void>;
  signalCleanup?: () => void;
}

function createRelease(): ForegroundRelease {
  let resolve!: (reason: ForegroundTaskReleaseReason) => void;
  const promise = new Promise<ForegroundTaskReleaseReason>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function isTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createFakeTaskService(
  options: { maxRunningTasks?: number; outputPersistenceAvailable?: boolean } = {},
): {
  readonly service: IAgentTaskService;
  readonly tasks: Map<string, ManagedEntry>;
  readonly persisted: Set<string>;
} {
  const tasks = new Map<string, ManagedEntry>();
  const persisted = new Set<string>();
  let counter = 0;

  const nextId = (prefix: string): string => {
    counter += 1;
    const suffix = counter.toString(TASK_ID_ALPHABET.length).padStart(8, '0');
    return `${prefix}-${suffix}`;
  };

  const entryToInfo = (entry: ManagedEntry): AgentTaskInfo => {
    return entry.task.toInfo({
      taskId: entry.taskId,
      description: entry.task.description,
      status: entry.status,
      detached: entry.foregroundRelease === undefined,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stopReason: entry.stopReason,
    });
  };

  const settleTask = (entry: ManagedEntry, settlement: AgentTaskSettlement): boolean => {
    if (isTerminal(entry.status)) return false;
    entry.status = settlement.status;
    entry.endedAt = Date.now();
    entry.stopReason =
      settlement.stopReason ?? (settlement.status === 'killed' ? entry.stopReason : undefined);
    entry.signalCleanup?.();
    entry.signalCleanup = undefined;
    if (entry.timeoutHandle !== undefined) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
    entry.foregroundRelease?.resolve('terminal');
    const waiters = entry.waiters.splice(0);
    for (const waiter of waiters) waiter();
    return true;
  };

  const stopEntry = async (
    entry: ManagedEntry,
    reason: string | undefined,
  ): Promise<AgentTaskInfo> => {
    if (isTerminal(entry.status)) return entryToInfo(entry);
    entry.stopReason = reason;
    entry.abortController.abort(reason);

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceful = await Promise.race([
      entry.lifecyclePromise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => {
          resolve(false);
        }, SIGTERM_GRACE_MS);
        graceTimer.unref?.();
      }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    if (isTerminal(entry.status)) return entryToInfo(entry);
    if (!graceful) {
      try {
        await entry.task.forceStop?.();
      } catch {
      }
    }
    if (isTerminal(entry.status)) return entryToInfo(entry);
    settleTask(entry, { status: 'killed', stopReason: reason });
    return entryToInfo(entry);
  };

  const detachEntry = (entry: ManagedEntry, viaTimeout: boolean): AgentTaskInfo => {
    if (isTerminal(entry.status)) return entryToInfo(entry);
    const release = entry.foregroundRelease;
    if (release === undefined) return entryToInfo(entry);
    entry.foregroundRelease = undefined;
    entry.signalCleanup?.();
    entry.signalCleanup = undefined;
    const detachTimeoutMs = entry.options.detachTimeoutMs;
    if (detachTimeoutMs !== undefined) {
      if (entry.timeoutHandle !== undefined) {
        clearTimeout(entry.timeoutHandle);
        entry.timeoutHandle = undefined;
      }
      if (detachTimeoutMs > 0) {
        entry.timeoutHandle = setTimeout(() => {
          entry.abortController.abort('Timed out');
          void settleTask(entry, { status: 'timed_out' });
        }, detachTimeoutMs);
        entry.timeoutHandle.unref?.();
      }
    }
    try {
      entry.task.onDetach?.();
    } catch {
    }
    release.resolve(viaTimeout ? 'timeout_detached' : 'detached');
    return entryToInfo(entry);
  };

  const activeDetachedCount = (): number => {
    let count = 0;
    for (const entry of tasks.values()) {
      if (entry.startedDetached && !isTerminal(entry.status)) count += 1;
    }
    return count;
  };

  const service: IAgentTaskService = {
    _serviceBrand: undefined,
    track(): never {
      throw new Error('fake IAgentTaskService.track is not implemented');
    },

    registerTask(task: AgentTask, registerOptions: RegisterAgentTaskOptions = {}): string {
      const detached = registerOptions.detached ?? true;
      if (detached && options.maxRunningTasks !== undefined) {
        if (activeDetachedCount() >= options.maxRunningTasks) {
          throw new Error('Too many background tasks are already running.');
        }
      }

      const taskId = nextId(task.idPrefix);
      const abortController = new AbortController();
      const entry: ManagedEntry = {
        taskId,
        task,
        startedDetached: detached,
        options: registerOptions,
        outputChunks: [],
        abortController,
        startedAt: Date.now(),
        waiters: [],
        status: 'running',
        endedAt: null,
        foregroundRelease: detached ? undefined : createRelease(),
        lifecyclePromise: Promise.resolve(),
      };
      tasks.set(taskId, entry);

      const timeoutMs = registerOptions.timeoutMs;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        entry.timeoutHandle = setTimeout(() => {
          if (
            registerOptions.autoBackgroundOnTimeout === true &&
            entry.foregroundRelease !== undefined
          ) {
            detachEntry(entry, true);
            return;
          }
          entry.abortController.abort('Timed out');
          void settleTask(entry, { status: 'timed_out' });
        }, timeoutMs);
        entry.timeoutHandle.unref?.();
      }

      entry.lifecyclePromise = Promise.resolve()
        .then(() =>
          task.start({
            signal: abortController.signal,
            appendOutput: (chunk: string) => {
              entry.outputChunks.push(chunk);
            },
            settle: async (settlement: AgentTaskSettlement) => settleTask(entry, settlement),
          }),
        )
        .catch((error: unknown) => {
          const status = abortController.signal.aborted ? 'killed' : 'failed';
          void settleTask(entry, {
            status,
            stopReason: status === 'failed' ? errorMessage(error) : undefined,
          });
        });

      if (!detached && registerOptions.signal !== undefined) {
        const signal = registerOptions.signal;
        const abortFromSignal = (): void => {
          if (entry.foregroundRelease === undefined) return;
          void stopEntry(entry, userCancellationReason().message);
        };
        if (signal.aborted) {
          abortFromSignal();
        } else {
          signal.addEventListener('abort', abortFromSignal, { once: true });
          entry.signalCleanup = () => {
            signal.removeEventListener('abort', abortFromSignal);
          };
        }
      }

      return taskId;
    },

    getTask(taskId: string): AgentTaskInfo | undefined {
      const entry = tasks.get(taskId);
      return entry === undefined ? undefined : entryToInfo(entry);
    },

    list(activeOnly = true): readonly AgentTaskInfo[] {
      const result: AgentTaskInfo[] = [];
      for (const entry of tasks.values()) {
        const info = entryToInfo(entry);
        if (activeOnly && isTerminal(info.status)) continue;
        result.push(info);
      }
      return result;
    },

    persistOutput(taskId: string): void {
      if (options.outputPersistenceAvailable !== false) persisted.add(taskId);
    },

    async getOutputSnapshot(taskId: string): Promise<AgentTaskOutputSnapshot> {
      const entry = tasks.get(taskId);
      const preview = entry === undefined ? '' : entry.outputChunks.join('');
      const fullOutputAvailable = persisted.has(taskId);
      return {
        outputPath: fullOutputAvailable ? `/fake/tasks/${taskId}/output.log` : undefined,
        outputSizeBytes: preview.length,
        previewBytes: preview.length,
        truncated: false,
        fullOutputAvailable,
        preview,
      };
    },

    async readOutput(taskId: string, tail?: number): Promise<string> {
      const entry = tasks.get(taskId);
      const output = entry === undefined ? '' : entry.outputChunks.join('');
      if (tail === undefined) return output;
      return output.slice(-Math.max(0, Math.trunc(tail)));
    },

    async suppressTerminalNotification(): Promise<void> {
    },

    markTasksDeliveredViaWait(): void {
    },

    detach(taskId: string): AgentTaskInfo | undefined {
      const entry = tasks.get(taskId);
      if (entry === undefined) return undefined;
      return detachEntry(entry, false);
    },

    async stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
      const entry = tasks.get(taskId);
      if (entry === undefined) return undefined;
      return stopEntry(entry, reason);
    },

    async stopByUser(taskId: string): Promise<AgentTaskInfo | undefined> {
      return service.stop(taskId, userCancellationReason().message);
    },

    async stopAll(reason?: string): Promise<readonly AgentTaskInfo[]> {
      const results = await Promise.all(
        Array.from(tasks.keys()).map((taskId) => service.stop(taskId, reason)),
      );
      return results.filter((info): info is AgentTaskInfo => info !== undefined);
    },

    async stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]> {
      return service.stopAll(reason);
    },

    async wait(taskId: string, timeoutMs = 30_000): Promise<AgentTaskInfo | undefined> {
      const entry = tasks.get(taskId);
      if (entry === undefined) return undefined;
      if (isTerminal(entry.status)) return entryToInfo(entry);
      let waiter: (() => void) | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            waiter = resolve;
            entry.waiters.push(resolve);
          }),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, timeoutMs);
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (waiter !== undefined) {
          const index = entry.waiters.indexOf(waiter);
          if (index !== -1) entry.waiters.splice(index, 1);
        }
      }
      return entryToInfo(entry);
    },

    async waitForForegroundRelease(
      taskId: string,
    ): Promise<ForegroundTaskReleaseReason | undefined> {
      const entry = tasks.get(taskId);
      if (entry === undefined) return undefined;
      if (isTerminal(entry.status)) return 'terminal';
      const release = entry.foregroundRelease;
      if (release === undefined) return 'detached';
      return Promise.race([
        release.promise,
        entry.lifecyclePromise.then(() => 'terminal' as const),
      ]);
    },
  };

  return { service, tasks, persisted };
}

function context(
  args: BashRunInput,
  signal = new AbortController().signal,
  onForegroundTaskStart?: (taskId: string) => void,
) {
  return { turnId: 0, toolCallId: 'call_bash', args, signal, onForegroundTaskStart };
}

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function executeTool(
  tool: BashTool,
  ctx: ReturnType<typeof context>,
): Promise<ExecutableToolResult> {
  const { args, ...executionContext } = ctx;
  const resolved = tool.resolveExecution(args);
  const execution = isPromiseLike(resolved) ? await resolved : resolved;
  if (execution.isError === true) return execution;
  return execution.execute(executionContext as ExecutableToolContext);
}

function stubToolPolicy(
  isToolActive: (name: string) => boolean = () => true,
): IAgentToolPolicyService {
  return {
    _serviceBrand: undefined,
    isToolActive,
  } as unknown as IAgentToolPolicyService;
}

function stubConfig(values: Record<string, unknown> = {}): IConfigService {
  return {
    _serviceBrand: undefined,
    get: (section: string) => values[section],
  } as unknown as IConfigService;
}

function stubStatefulShell(overrides: Partial<IAgentStatefulShell> = {}): IAgentStatefulShell {
  return {
    _serviceBrand: undefined,
    runTask: vi.fn(async (_input: StatefulShellRunInput): Promise<StatefulShellProcess> => ({
      ...processWithOutput(),
      detach: vi.fn(async () => {}),
    })),
    closeShell: vi.fn(async () => {}),
    ...overrides,
  };
}

function bashTool(
  runner: IHostProcessService,
  env: IHostEnvironment = createTestEnv(),
  ctx: ISessionContext = createTestCtx(),
  background: IAgentTaskService = createFakeTaskService().service,
  toolPolicy: IAgentToolPolicyService = stubToolPolicy(),
  config: IConfigService = stubConfig(),
  statefulShell: IAgentStatefulShell = stubStatefulShell(),
): BashTool {
  const processService: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: async (command, args = [], options) => runner.spawn(command, args, options),
  };
  const backend = Object.assign(
    new FakeRuntime(
      { workspaceId: ctx.workspaceId, runtimeId: 'local', generation: 'test' },
      { capabilities: ['process'], pathClass: env.pathClass },
    ),
    { environment: env, process: processService },
  );
  const runtime: IAgentRuntimeService = {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
    isAvailable: () => true,
    inspect: () => backend,
    acquire: () => ({
      runtime: backend,
      track: (resource) => resource,
      dispose: () => {},
    }),
  };
  return new BashTool(runtime, ctx, stubWorkspaceContext(ctx.cwd), background, toolPolicy, config, statefulShell);
}

describe('BashTool', () => {
  it('exposes current metadata and schema', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);

    expect(tool.name).toBe('Bash');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { command: { type: 'string' } },
    });
    expect(BashInputSchema.safeParse({ command: 'echo hello' }).success).toBe(true);
    expect(BashInputSchema.safeParse({ command: '' }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 0 }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 300 }).success).toBe(true);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 301 }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 300_000 }).success).toBe(false);
    expect(BashInputSchema.safeParse({ command: 'echo x', timeout: 300_001 }).success).toBe(false);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        timeout: 86_400,
      }).success,
    ).toBe(true);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        timeout: 86_401,
      }).success,
    ).toBe(false);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        timeout: 600_000,
      }).success,
    ).toBe(false);
    expect(
      BashInputSchema.safeParse({
        command: 'watch',
        run_in_background: true,
        description: 'watch files',
        disable_timeout: true,
      }).success,
    ).toBe(true);
  });

  it('describes the cwd, command, run_in_background, description, and disable_timeout parameters', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);
    const properties = (tool.parameters as { properties: Record<string, { description?: string }> })
      .properties;

    for (const name of [
      'cwd',
      'command',
      'run_in_background',
      'description',
      'disable_timeout',
    ] as const) {
      const description = properties[name]?.description;
      expect(description, `${name} should have a non-empty description`).toBeTruthy();
      expect((description ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('exposes a default timeout in the JSON Schema', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);
    const properties = (tool.parameters as { properties: Record<string, { default?: number }> })
      .properties;

    expect(properties['timeout']?.default).toBe(60);
  });

  it('renders the available commands section and the background-task panel hint', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);

    expect(tool.description).toContain('Commands available');
    expect(tool.description).toContain('background-task panel');
  });

  it('runs through runner.spawn, injects cwd, noninteractive env, and closes stdin', async () => {
    const proc = processWithOutput({ stdout: 'ok\n' });
    const { runner, exec } = createTestRunner(proc);
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'printf ok', timeout: 60 }));

    expect(exec).toHaveBeenCalledTimes(1);
    const [command, args, execOptions] = exec.mock.calls[0]!;
    expect(command).toBe('/bin/bash');
    expect(args).toEqual(['-c', "cd '/workspace' && printf ok"]);
    expect(execOptions?.env).toMatchObject({
      NO_COLOR: '1',
      TERM: 'dumb',
    });
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      output: 'ok\n',
      isError: false,
    });
  });

  it('uses args.cwd when provided', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: 'sub\n' }));
    const tool = bashTool(runner);

    await executeTool(tool, context({ command: 'pwd', cwd: '/workspace/project', timeout: 60 }));

    expect(exec.mock.calls[0]?.[0]).toBe('/bin/bash');
    expect(exec.mock.calls[0]?.[1]).toEqual(['-c', "cd '/workspace/project' && pwd"]);
  });

  it('uses the kaos cwd as the default working directory', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: '' }));
    const tool = bashTool(runner, posixEnv, createTestCtx('/var/app'));

    await executeTool(tool, context({ command: 'pwd', timeout: 60 }));

    expect(exec.mock.calls[0]?.[0]).toBe('/bin/bash');
    expect(exec.mock.calls[0]?.[1]).toEqual(['-c', "cd '/var/app' && pwd"]);
  });

  it('uses Git Bash semantics on Windows', async () => {
    const proc = processWithOutput({ stdout: 'ok\n' });
    const { runner, exec } = createTestRunner(proc);
    const tool = bashTool(runner, windowsBashEnv, createTestCtx('C:\\Users\\me\\project'));

    const result = await executeTool(tool, context({ command: 'echo ok 2>nul', timeout: 60 }));

    expect(exec).toHaveBeenCalledTimes(1);
    const [command, args, execOptions] = exec.mock.calls[0]!;
    expect(command).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(args).toEqual(['-c', "cd '/c/Users/me/project' && echo ok 2>/dev/null"]);
    expect(execOptions?.env).toMatchObject({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    expect(result).toMatchObject({
      output: 'ok\n',
      isError: false,
    });
  });

  it('returns stderr and marks non-zero exit codes as tool errors', async () => {
    const { runner } = createTestRunner(processWithOutput({ stderr: 'boom\n', exitCode: 2 }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'exit 2', timeout: 60 }));

    expect(result).toMatchObject({
      isError: true,
      brief: 'Failed with exit code: 2',
    });
    expect(result.output).toContain('boom\n');
    expect(result.output).toContain('Command failed with exit code: 2.');
  });

  it('returns both stdout and stderr when a command succeeds', async () => {
    const { runner } = createTestRunner(processWithOutput({ stdout: 'out\n', stderr: 'warn\n' }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'mixed', timeout: 60 }));

    expect(result).toMatchObject({
      output: 'out\nwarn\n',
      isError: false,
    });
  });

  it('returns both stdout and stderr when a command fails', async () => {
    const { runner } = createTestRunner(
      processWithOutput({ stdout: 'partial\n', stderr: 'boom\n', exitCode: 2 }),
    );
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'mixed fail', timeout: 60 }));

    expect(result).toMatchObject({
      isError: true,
      brief: 'Failed with exit code: 2',
    });
    expect(result.output).toContain('partial\nboom\n');
    expect(result.output).toContain('Command failed with exit code: 2.');
  });

  it('returns the service failure reason when foreground process wait rejects', async () => {
    const { runner } = createTestRunner(
      processWithOutput({
        stdout: 'partial output\n',
        exitCode: null,
        wait: async () => {
          throw new Error('wait failed');
        },
      }),
    );
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'wait fails', timeout: 60 }));

    expect(result).toMatchObject({
      isError: true,
      brief: 'wait failed',
    });
    expect(result.output).toContain('partial output\nwait failed');
    expect(result.output).not.toContain('exit code: null');
  });

  it('preserves foreground stdout and stderr arrival order', async () => {
    vi.useFakeTimers();
    try {
      const proc = processWithInterleavedOutput([
        { stream: 'stderr', text: 'err-first\n', delayMs: 0 },
        { stream: 'stdout', text: 'out-second\n', delayMs: 5 },
        { stream: 'stderr', text: 'err-third\n', delayMs: 10 },
      ]);
      const { runner } = createTestRunner(proc);
      const tool = bashTool(runner);

      const resultPromise = executeTool(tool, context({ command: 'mixed', timeout: 60 }));
      await vi.advanceTimersByTimeAsync(11);

      const result = await resultPromise;
      expect(result).toMatchObject({
        isError: false,
        output: 'err-first\nout-second\nerr-third\n',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('interprets small timeout values as seconds at runtime', async () => {
    vi.useFakeTimers();
    try {
      let resolveWait: (code: number) => void = () => {};
      const waitPromise = new Promise<number>((resolve) => {
        resolveWait = resolve;
      });
      const proc = processWithOutput({
        wait: async () => waitPromise,
        kill: async () => {
          resolveWait(143);
        },
      });
      const { runner } = createTestRunner(proc);
      const tool = bashTool(runner);

      const running = executeTool(tool, context({ command: 'sleep 3', timeout: 2 }));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(proc.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const result = await running;

      expect(proc.kill).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isError: false,
      });
      expect(result.output).toContain('task_id: bash-');
      resolveWait(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a timed-out command with the timeout message when auto-background is disabled', async () => {
    vi.useFakeTimers();
    try {
      let resolveWait: (code: number) => void = () => {};
      const waitPromise = new Promise<number>((resolve) => {
        resolveWait = resolve;
      });
      const proc = processWithOutput({
        wait: async () => waitPromise,
        kill: async () => {
          resolveWait(143);
        },
      });
      const { runner } = createTestRunner(proc);
      const tool = bashTool(
        runner,
        createTestEnv(),
        createTestCtx(),
        createFakeTaskService().service,
        stubToolPolicy(),
        stubConfig({ task: { bashAutoBackgroundOnTimeout: false } }),
      );

      const running = executeTool(tool, context({ command: 'sleep 2', timeout: 1 }));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(250);
      const result = await running;

      expect(result).toMatchObject({ isError: true, brief: 'Killed by timeout (1s)' });
      expect(result.output).toContain('Command killed by timeout (1s)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports timeout instead of premature close when cleanup destroys open output streams', async () => {
    vi.useFakeTimers();
    try {
      const proc = processWithOpenStreamsThatExitOnKill();
      const { runner } = createTestRunner(proc);
      const tool = bashTool(
        runner,
        createTestEnv(),
        createTestCtx(),
        createFakeTaskService().service,
        stubToolPolicy(),
        stubConfig({ task: { bashAutoBackgroundOnTimeout: false } }),
      );

      const running = executeTool(tool, context({ command: 'sleep 2', timeout: 1 }));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(250);
      const result = await running;

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(result).toMatchObject({ isError: true, brief: 'Killed by timeout (1s)' });
      expect(result.output).toContain('Command killed by timeout (1s)');
      expect(result.output).not.toContain('Premature close');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a stream read error as a tool error even when the process exits with code 0', async () => {
    const proc = processWithStreamError({
      stdoutError: new Error('SSH channel read failed'),
      exitCode: 0,
    });
    const { runner } = createTestRunner(proc);
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'remote-cmd', timeout: 60 }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('SSH channel read failed');
  });

  it('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runner, exec } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'echo nope' }, controller.signal));

    expect(result).toEqual({ isError: true, output: 'Aborted before command started' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('kills the process and returns an abort result when aborted while running', async () => {
    let resolveWait: (code: number) => void = () => {};
    const waitPromise = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const proc = processWithOutput({
      wait: async () => waitPromise,
      kill: async () => {
        resolveWait(143);
      },
    });
    const { runner } = createTestRunner(proc);
    const controller = new AbortController();
    const tool = bashTool(runner);

    const running = executeTool(tool, context({ command: 'sleep 10' }, controller.signal));
    await vi.waitFor(() => {
      expect(proc.stdin.end).toHaveBeenCalled();
    });
    controller.abort();
    const result = await running;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Interrupted by user');
  });

  it('caps retained output and reports the true total via spill when stdout exceeds the retention cap', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'yes', timeout: 60 }));

    expect(result.output).toBe('x'.repeat(10_000_000));
    expect(result.spill?.totalChars).toBe(10 * 1024 * 1024 + 1);
  });

  it('does not shape output inline at the tool layer', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge }));
    const { service } = createFakeTaskService({ outputPersistenceAvailable: false });
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'yes', timeout: 60 }));

    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).not.toContain('[...truncated]');
    expect(output).not.toContain('Output is truncated');
    expect(result.spill?.suffix).toBe('Command executed successfully.');
  });

  it('appends the failure message after retained output when the command fails', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'E');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge, exitCode: 1 }));
    const tool = bashTool(runner);

    const result = await executeTool(tool, context({ command: 'fail-and-flood', timeout: 60 }));

    expect(result).toMatchObject({ isError: true });
    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output.startsWith('E'.repeat(10_000_000))).toBe(true);
    expect(output).toContain('Command failed with exit code: 1.');
    expect(result.spill?.totalChars).toBe(10 * 1024 * 1024 + 1);
  });

  it('points the spill at the persisted task log when foreground output exceeds the delivery cap', async () => {
    const fullOutput = `${'short line\n'.repeat(6_000)}tail survives\n`;
    const { runner } = createTestRunner(processWithOutput({ stdout: fullOutput }));
    const { service, persisted } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'flood', timeout: 60 }));

    expect(result.output).toBe(fullOutput);
    const spill = result.spill;
    expect(spill).toBeDefined();
    const taskId = /^\/fake\/tasks\/(bash-[0-9a-z]{8})\/output\.log$/.exec(
      spill!.outputPath!,
    )?.[1];
    expect(taskId).toBeTruthy();
    expect(persisted.has(taskId!)).toBe(true);
    expect(spill!.totalChars).toBe(fullOutput.length);
    expect(spill!.suffix).toContain(`task_id: ${taskId}`);
    expect(spill!.suffix).toContain('output_size_bytes:');
    expect(spill!.suffix).toContain(`TaskOutput(task_id="${taskId}")`);
  });

  it('leaves the result for generic pipeline spill when task-log persistence is unavailable', async () => {
    const fullOutput = `${'short line\n'.repeat(6_000)}tail survives\n`;
    const { runner } = createTestRunner(processWithOutput({ stdout: fullOutput }));
    const { service, persisted } = createFakeTaskService({ outputPersistenceAvailable: false });
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'flood', timeout: 60 }));

    expect(result.output).toBe(fullOutput);
    expect(result.spill).toEqual({ suffix: 'Command executed successfully.' });
    expect(persisted.size).toBe(0);
  });

  it('leaves the result untouched at exactly the delivery cap boundary', async () => {
    const fullOutput = 'x'.repeat(50_000);
    const { runner } = createTestRunner(processWithOutput({ stdout: fullOutput }));
    const { service, persisted } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'edge', timeout: 60 }));

    expect(result.output).toBe(fullOutput);
    expect(result.spill).toBeUndefined();
    expect(persisted.size).toBe(0);
  });

  it('reuses the persisted task log even when output exceeds the retention budget', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'x');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge }));
    const { service, persisted } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'yes', timeout: 60 }));

    expect(persisted.size).toBe(1);
    const taskId = /^\/fake\/tasks\/(bash-[0-9a-z]{8})\/output\.log$/.exec(
      result.spill!.outputPath!,
    )?.[1];
    expect(taskId).toBeTruthy();
    expect(persisted.has(taskId!)).toBe(true);
    expect(result.spill?.totalChars).toBe(10 * 1024 * 1024 + 1);
  });

  it('carries the failure message in the spill suffix when retention capped the output', async () => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 'E');
    const { runner } = createTestRunner(processWithOutput({ stdout: huge, exitCode: 1 }));
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(tool, context({ command: 'fail-and-flood', timeout: 60 }));

    expect(result).toMatchObject({ isError: true });
    expect(result.spill?.suffix).toContain('Command failed with exit code: 1.');
  });

  it('omits the TaskOutput hint from the spill suffix when background tools are disabled', async () => {
    const fullOutput = 'short line\n'.repeat(6_000);
    const { runner } = createTestRunner(processWithOutput({ stdout: fullOutput }));
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service, stubToolPolicy(() => false));

    const result = await executeTool(tool, context({ command: 'flood', timeout: 60 }));

    expect(result.spill?.outputPath).toContain('/fake/tasks/');
    expect(result.spill?.suffix).toContain('task_id:');
    expect(result.spill?.suffix).not.toContain('TaskOutput');
  });

  it('rejects empty-string commands at the schema layer', () => {
    expect(BashInputSchema.safeParse({ command: '' }).success).toBe(false);
  });

  it('does not inject GIT_SSH_COMMAND into the spawn environment', async () => {
    const previous = process.env['GIT_SSH_COMMAND'];
    delete process.env['GIT_SSH_COMMAND'];
    try {
      const { runner, exec } = createTestRunner(processWithOutput({ stdout: 'ok\n' }));
      const tool = bashTool(runner);

      await executeTool(tool, context({ command: 'true', timeout: 60 }));

      const env = exec.mock.calls[0]?.[2]?.env as Record<string, string>;
      expect(Object.prototype.hasOwnProperty.call(env, 'GIT_SSH_COMMAND')).toBe(false);
    } finally {
      if (previous !== undefined) process.env['GIT_SSH_COMMAND'] = previous;
    }
  });

  it('rewrites nul-redirect on Windows so the spawned argv has /dev/null', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: '' }));
    const tool = bashTool(runner, windowsBashEnv, createTestCtx('C:\\Users\\me\\project'));

    await executeTool(tool, context({ command: 'ls 2>nul', timeout: 60 }));

    const args = exec.mock.calls[0]?.[1] as readonly string[];
    expect(args[1]).toBe("cd '/c/Users/me/project' && ls 2>/dev/null");
  });

  it('passes nul-redirect through unchanged on Linux so the argv keeps the literal file target', async () => {
    const { runner, exec } = createTestRunner(processWithOutput({ stdout: '' }));
    const tool = bashTool(runner);

    await executeTool(tool, context({ command: 'ls 2>nul', timeout: 60 }));

    const args = exec.mock.calls[0]?.[1] as readonly string[];
    expect(args[1]).toBe("cd '/workspace' && ls 2>nul");
  });

  it('exposes a shell description that documents /bin/bash, TaskOutput/TaskStop, safety and efficiency sections, and background semantics', () => {
    const { runner } = createTestRunner(processWithOutput());
    const tool = bashTool(runner);

    const description = tool.description;
    expect(description).toContain('`bash`');
    expect(description).toContain('TaskOutput');
    expect(description).toContain('TaskStop');
    expect(description).toContain('**Guidelines for safety and security:**');
    expect(description).toContain('**Guidelines for efficiency:**');
    expect(description).toContain('run_in_background=true');
  });

  it('disables background execution when TaskList is inactive even if TaskOutput/TaskStop are active', async () => {
    const { runner, exec } = createTestRunner(processWithOutput());
    const tool = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy((name) => name !== 'TaskList'),
    );

    const result = await executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'watch' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Background execution is not available');
    expect(exec).not.toHaveBeenCalled();
  });

  it('resolves the detach timeout from the bashTaskTimeoutS config', async () => {
    async function detachTimeoutMsFor(
      configValues: Record<string, unknown>,
    ): Promise<number | undefined> {
      const { runner } = createTestRunner(processWithOutput());
      const { service, tasks } = createFakeTaskService();
      const tool = bashTool(
        runner,
        createTestEnv(),
        createTestCtx(),
        service,
        stubToolPolicy(),
        stubConfig(configValues),
      );

      const result = await executeTool(
        tool,
        context({ command: 'watch', run_in_background: true, description: 'watch files' }),
      );
      expect(result).toMatchObject({ isError: false });

      const taskId = service.list(false)[0]!.taskId;
      return tasks.get(taskId)?.options.detachTimeoutMs;
    }

    await expect(detachTimeoutMsFor({})).resolves.toBe(600_000);
    await expect(detachTimeoutMsFor({ task: { bashTaskTimeoutS: 30 } })).resolves.toBe(30_000);
    await expect(detachTimeoutMsFor({ background: { bashTaskTimeoutS: 45 } })).resolves.toBe(
      45_000,
    );
    await expect(detachTimeoutMsFor({ task: { bashTaskTimeoutS: 0 } })).resolves.toBe(0);
  });
});

describe('BashTool background mode', () => {
  it('can detach a foreground command through the background service', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const running = executeTool(tool, context({ command: 'sleep 10', timeout: 60 }));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;
    await vi.waitFor(() => {
      expect((proc.stdout as PassThrough).listenerCount('data')).toBeGreaterThanOrEqual(1);
    });
    (proc.stdout as PassThrough).write('before detach\n');

    expect(task).toMatchObject({
      kind: 'process',
      detached: false,
      command: 'sleep 10',
    });

    service.detach(task.taskId);
    const result = await running;
    (proc.stdout as PassThrough).write('after detach\n');

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('before detach\n');
    expect(result.output).not.toContain('after detach\n');
    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('automatic_notification: true');
    expect(result.output).toContain('The user moved this task to the background.');
    expect(result.output).toContain('detached_by_user: true');
    expect(result.output).toContain('do NOT wait, poll, or call TaskOutput');
    expect(result.output).toContain('human_shell_hint: The task is visible in the background-task panel.');
    expect((result as { brief?: string }).brief).toBe(`Backgrounded ${task.taskId} by the user`);
    expect(service.getTask(task.taskId)).toMatchObject({ detached: true });
    await vi.waitFor(async () => {
      await expect(service.readOutput(task.taskId)).resolves.toContain('after detach\n');
    });

    finish();
    await expect(service.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('notifies when a foreground command registers its background task', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);
    const started = vi.fn();

    const running = executeTool(tool, context({ command: 'sleep 10', timeout: 60 }, undefined, started));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;

    expect(started).toHaveBeenCalledWith(task.taskId);

    finish();
    await running;
  });

  it('records the parent tool call id on the registered task', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const running = executeTool(tool, context({ command: 'sleep 10', timeout: 60 }));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;

    expect(task).toMatchObject({
      kind: 'process',
      detached: false,
      parentToolCallId: 'call_bash',
    });

    finish();
    await running;
  });

  it('applies the background timeout when a foreground command is detached', async () => {
    vi.useFakeTimers();
    try {
      const { proc } = pendingProcess();
      const { runner } = createTestRunner(proc);
      const { service } = createFakeTaskService();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const running = executeTool(tool, context({ command: 'sleep 10', timeout: 1 }));
      await vi.waitFor(() => {
        expect(service.list(false)).toHaveLength(1);
      });
      const task = service.list(false)[0]!;

      service.detach(task.taskId);
      await running;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(service.getTask(task.taskId)?.status).toBe('running');

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(service.getTask(task.taskId)?.status).toBe('timed_out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves a timed-out foreground command to the background instead of killing it', async () => {
    vi.useFakeTimers();
    try {
      const { proc, finish } = pendingProcess();
      const { runner } = createTestRunner(proc);
      const { service } = createFakeTaskService();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const running = executeTool(tool, context({ command: 'sleep 30', timeout: 1 }));
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await running;

      expect(proc.kill).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isError: false,
        brief: expect.stringContaining('after timeout'),
      });
      expect(result.output).toContain('The task now runs in the background.');
      expect(result.output).not.toContain('The user moved this task');
      expect(result.output).not.toContain('detached_by_user');
      expect(result.output).toContain('human_shell_hint: The task is visible in the background-task panel.');
      const taskId = /^task_id: (\S+)/m.exec(result.output as string)?.[1];
      expect(taskId).toBeDefined();
      expect(service.getTask(taskId!)).toMatchObject({ status: 'running', detached: true });

      (proc.stdout as PassThrough).write('after timeout\n');
      finish(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(service.getTask(taskId!)).toMatchObject({ status: 'completed' });
      await expect(service.readOutput(taskId!)).resolves.toContain('after timeout\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not recommend disabled task tools when a foreground command is detached', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service, stubToolPolicy(() => false));

    const running = executeTool(tool, context({ command: 'sleep 10', timeout: 60 }));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;

    service.detach(task.taskId);
    const result = await running;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('You will be automatically notified when it completes');
    expect(result.output).toContain('do NOT wait or poll');
    expect(result.output).not.toContain('TaskOutput');
    expect(result.output).not.toContain('TaskStop');

    finish();
    await expect(service.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('keeps task metadata independent when noisy foreground output is detached', async () => {
    const { proc, finish } = pendingProcess();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const running = executeTool(tool, context({ command: 'yes noisy', timeout: 60 }));
    await vi.waitFor(() => {
      expect(service.list(false)).toHaveLength(1);
    });
    const task = service.list(false)[0]!;
    await vi.waitFor(() => {
      expect((proc.stdout as PassThrough).listenerCount('data')).toBeGreaterThanOrEqual(1);
    });

    (proc.stdout as PassThrough).write(
      Array.from({ length: 6000 }, (_, index) => `noisy output line ${String(index)}\n`).join(''),
    );
    service.detach(task.taskId);
    const result = await running;

    expect(result).toMatchObject({ isError: false });
    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain(`task_id: ${task.taskId}`);
    expect(output).toContain('automatic_notification: true');
    expect(output).toContain('foreground_output:');
    expect(output).toContain('noisy output line 0');
    expect(output).toContain('noisy output line 5999');
    expect(output).not.toContain('[...truncated]');
    expect(output.indexOf(`task_id: ${task.taskId}`)).toBeLessThan(
      output.indexOf('foreground_output:'),
    );

    finish();
    await expect(service.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('requires background tools to be enabled and description for background commands', async () => {
    const proc = processWithOutput();
    const { runner, exec } = createTestRunner(proc);
    const backgroundDisabled = bashTool(
      runner,
      createTestEnv(), createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(() => false),
    );

    const unavailable = await executeTool(
      backgroundDisabled,
      context({ command: 'sleep 10', run_in_background: true, description: 'watch' }),
    );
    expect(unavailable).toMatchObject({ isError: true });
    expect(unavailable.output).toContain('Background execution is not available');
    expect(exec).not.toHaveBeenCalled();

    const { service } = createFakeTaskService();
    const withService = bashTool(runner, createTestEnv(), createTestCtx(), service);
    const missingDescription = await executeTool(
      withService,
      context({ command: 'sleep 10', run_in_background: true }),
    );

    expect(missingDescription).toMatchObject({ isError: true });
    expect(missingDescription.output).toContain('description is required');
    expect(exec).not.toHaveBeenCalled();
  });

  it('registers background commands and returns a task id', async () => {
    const proc = processWithOutput();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'long running task' }),
    );

    expect(result.output).toMatch(/task_id: bash-[0-9a-z]{8}/);
    expect(result.output).toContain('automatic_notification: true');
    expect((result as { brief?: string }).brief).toMatch(/^Started bash-[0-9a-z]{8}$/);
    expect(result.output).toContain('do NOT wait, poll, or call TaskOutput on it');
    expect(result.output).not.toContain('block=false');
    expect(service.list(false)).toHaveLength(1);
  });

  it('kills a spawned background command when the task limit is reached', async () => {
    const { service } = createFakeTaskService({ maxRunningTasks: 1 });
    service.registerTask(new ProcessTask(processWithOutput(), 'sleep 10', 'existing task'));
    const rejectedProc = processWithOutput();
    const { runner, exec } = createTestRunner(rejectedProc);
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'second task' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Too many background tasks are already running.',
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(rejectedProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects one of two concurrent background commands when the task limit is reached', async () => {
    const { service } = createFakeTaskService({ maxRunningTasks: 1 });
    const firstProc = processWithOutput({
      wait: () => new Promise(() => {}),
    });
    const secondProc = processWithOutput();
    const exec = vi.fn().mockResolvedValueOnce(firstProc).mockResolvedValueOnce(secondProc);
    const { runner } = createTestRunner(exec);
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const first = executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'first task' }),
    );
    const second = executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'second task' }),
    );

    const results = await Promise.all([first, second]);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(secondProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(results).toContainEqual(expect.objectContaining({ isError: false }));
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
  });

  it('uses Git Bash semantics and rejects the concurrent command at the task limit', async () => {
    const { service } = createFakeTaskService({ maxRunningTasks: 1 });
    const firstProc = processWithOutput({
      wait: () => new Promise(() => {}),
    });
    const secondProc = processWithOutput();
    const exec = vi.fn().mockResolvedValueOnce(firstProc).mockResolvedValueOnce(secondProc);
    const { runner } = createTestRunner(exec);
    const tool = bashTool(runner, windowsBashEnv, createTestCtx('C:\\Users\\me\\project'), service);

    const first = executeTool(
      tool,
      context({
        command: 'echo ok 2>nul',
        run_in_background: true,
        description: 'first task',
      }),
    );
    const second = executeTool(
      tool,
      context({
        command: 'echo second',
        run_in_background: true,
        description: 'second task',
      }),
    );

    const results = await Promise.all([first, second]);

    expect(exec).toHaveBeenCalledTimes(2);
    const [command, args, execOptions] = exec.mock.calls[0]!;
    expect(command).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(args).toEqual(['-c', "cd '/c/Users/me/project' && echo ok 2>/dev/null"]);
    expect(execOptions?.env).toMatchObject({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' });
    expect(secondProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(results).toContainEqual(expect.objectContaining({ isError: false }));
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
  });

  it('timeout-stops a background task that has not settled even if process exit is visible', async () => {
    vi.useFakeTimers();
    try {
      const { proc, finishWait, markExited } = processWithVisibleExitBeforeWait(0);
      const { runner } = createTestRunner(proc);
      const { service } = createFakeTaskService();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const result = await executeTool(
        tool,
        context({
          command: 'sleep 10',
          run_in_background: true,
          description: 'exit before close',
          timeout: 1,
        }),
      );
      expect(typeof result.output).toBe('string');
      if (typeof result.output !== 'string') throw new Error('Expected string tool output.');
      const taskId = result.output.match(/task_id: (bash-[0-9a-z]{8})/)?.[1];
      expect(taskId).toBeDefined();

      markExited();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      finishWait();
      await vi.runAllTimersAsync();

      expect(service.getTask(taskId!)?.status).toBe('timed_out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeout-stops a background task after the default 10 minute deadline', async () => {
    vi.useFakeTimers();
    try {
      const proc = processThatNeverExits();
      const { runner } = createTestRunner(proc);
      const { service } = createFakeTaskService();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const result = await executeTool(
        tool,
        context({
          command: 'sleep 999',
          run_in_background: true,
          description: 'default deadline',
        }),
      );
      expect(result).toMatchObject({ isError: false });

      await vi.advanceTimersByTimeAsync(600_000);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not timeout-stop a background task when disable_timeout is true', async () => {
    vi.useFakeTimers();
    try {
      const proc = processThatNeverExits();
      const { runner } = createTestRunner(proc);
      const { service } = createFakeTaskService();
      const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

      const result = await executeTool(
        tool,
        context({
          command: 'sleep 999',
          run_in_background: true,
          description: 'no deadline',
          disable_timeout: true,
        }),
      );
      expect(result).toMatchObject({ isError: false });

      await vi.advanceTimersByTimeAsync(600_000 + 10_000);

      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports background task startup with task_id, status, automatic_notification, and a human-shell hint', async () => {
    const proc = processWithOutput();
    const { runner } = createTestRunner(proc);
    const { service } = createFakeTaskService();
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 1', run_in_background: true, description: 'sleep task' }),
    );

    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain('task_id:');
    expect(output).toContain('status: running');
    expect(output).toContain('automatic_notification: true');
    expect(output).toContain('do NOT wait, poll, or call TaskOutput on it');
    expect(output).not.toContain('block=false');
    expect(output).toContain('human_shell_hint: The task is visible in the background-task panel.');
    expect(output).not.toContain('/tasks');
  });

  it('rejects background command without description (description-required guard)', async () => {
    const { service } = createFakeTaskService();
    const { runner, exec } = createTestRunner(processWithOutput());
    const tool = bashTool(runner, createTestEnv(), createTestCtx(), service);

    const result = await executeTool(
      tool,
      context({ command: 'sleep 1', run_in_background: true }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('description is required');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('BashTool prompt / runtime consistency', () => {
  it('reports unavailable background using only tools the prompt documents', async () => {
    const { runner } = createTestRunner(processWithOutput());

    const enabledTool = bashTool(runner);
    const promptToolNames = new Set(
      [...enabledTool.description.matchAll(/`(Task[A-Za-z]+)`/g)].map((match) => match[1]),
    );

    const tool = bashTool(runner, createTestEnv(), createTestCtx(), createFakeTaskService().service, stubToolPolicy(() => false));
    const result = await executeTool(
      tool,
      context({ command: 'sleep 10', run_in_background: true, description: 'watch' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(typeof result.output).toBe('string');
    const errorToolNames = [...(result.output as string).matchAll(/\b(Task[A-Za-z]+)\b/g)].map(
      (match) => match[1],
    );

    for (const name of errorToolNames) {
      expect(promptToolNames).toContain(name);
    }
    expect(errorToolNames.length).toBeGreaterThan(0);
  });
});

describe('BashTool stateful dispatch', () => {
  it('dispatches to the resuming shell when [bash] stateful = true', async () => {
    const { runner } = createTestRunner(processWithOutput());
    const statefulShell = stubStatefulShell();
    const tool = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(),
      stubConfig({ bash: { stateful: true } }),
      statefulShell,
    );

    const result = await executeTool(tool, context({ command: 'echo hi' }));
    expect(result).toMatchObject({ isError: false });

    const input = vi.mocked(statefulShell.runTask).mock.calls[0]?.[0];

    expect(input).toMatchObject({ command: 'echo hi', cwd: '/workspace', background: false });
    expect(statefulShell.closeShell).not.toHaveBeenCalled();
  });

  it('lets a user `!` command (userInitiated) run at the restored snapshot cwd', async () => {
    const { runner } = createTestRunner(processWithOutput());
    const statefulShell = stubStatefulShell();
    const tool = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(),
      stubConfig({ bash: { stateful: true } }),
      statefulShell,
    );

    await executeTool(tool, context({ command: 'echo hi', userInitiated: true }));

    const input = vi.mocked(statefulShell.runTask).mock.calls[0]?.[0];

    expect(input).toMatchObject({ command: 'echo hi', cwd: undefined, background: false });
  });

  it('passes an explicit cwd through to the task', async () => {
    const { runner } = createTestRunner(processWithOutput());
    const statefulShell = stubStatefulShell();
    const tool = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(),
      stubConfig({ bash: { stateful: true } }),
      statefulShell,
    );

    await executeTool(tool, context({ command: 'echo hi', cwd: '/workspace/sub' }));

    const input = vi.mocked(statefulShell.runTask).mock.calls[0]?.[0];
    expect(input).toMatchObject({ command: 'echo hi', cwd: '/workspace/sub' });
  });

  it('spawns a fresh shell and closes the resuming one when the flag is off', async () => {
    const { runner, exec } = createTestRunner(processWithOutput());
    const statefulShell = stubStatefulShell();
    const tool = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(),
      stubConfig({ bash: { stateful: false } }),
      statefulShell,
    );

    const result = await executeTool(tool, context({ command: 'echo hi' }));
    expect(result).toMatchObject({ isError: false });
    expect(statefulShell.runTask).not.toHaveBeenCalled();
    expect(statefulShell.closeShell).toHaveBeenCalled();
    expect(exec).toHaveBeenCalled();
  });

  it('closes the resuming shell when the flag flips off mid-session', async () => {
    const { runner } = createTestRunner(processWithOutput());
    const values: Record<string, unknown> = { bash: { stateful: true } };
    const statefulShell = stubStatefulShell();
    const tool = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(),
      stubConfig(values),
      statefulShell,
    );

    await executeTool(tool, context({ command: 'echo one' }));
    expect(vi.mocked(statefulShell.runTask).mock.calls.length).toBe(1);
    expect(statefulShell.closeShell).not.toHaveBeenCalled();

    values['bash'] = { stateful: false };
    await executeTool(tool, context({ command: 'echo two' }));
    expect(vi.mocked(statefulShell.runTask).mock.calls.length).toBe(1);
    expect(statefulShell.closeShell).toHaveBeenCalled();
  });

  it('marks background runs so they never commit state', async () => {
    const { runner } = createTestRunner(processWithOutput());
    const statefulShell = stubStatefulShell();
    const tool = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(),
      stubConfig({ bash: { stateful: true } }),
      statefulShell,
    );

    await executeTool(
      tool,
      context({
        command: 'sleep 1',
        run_in_background: true,
        description: 'bg stateful',
      }),
    );

    const input = vi.mocked(statefulShell.runTask).mock.calls[0]?.[0];
    expect(input).toMatchObject({ command: 'sleep 1', background: true });
  });

  it('renders the stateful description when enabled, the fresh-shell one otherwise', () => {
    const { runner } = createTestRunner(processWithOutput());
    const stateful = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(),
      stubConfig({ bash: { stateful: true } }),
    );
    expect(stateful.description).toContain('stateful');
    expect(stateful.description).toContain('snapshot');
    expect(stateful.description).toContain('persists across calls');
    expect(stateful.description).toContain('commit ONLY');
    expect(stateful.description).toContain('roll back');
    expect(stateful.description).toContain('never commit');
    expect(stateful.description).toContain('run_in_background=true');
    expect(stateful.description).not.toContain('executed in a fresh shell environment');

    const plain = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(),
      stubConfig({ bash: { stateful: false } }),
    );
    expect(plain.description).not.toContain('this shell is stateful');

    const noBackground = bashTool(
      runner,
      createTestEnv(),
      createTestCtx(),
      createFakeTaskService().service,
      stubToolPolicy(() => false),
      stubConfig({ bash: { stateful: true } }),
    );
    expect(noBackground.description).toContain('Background execution is disabled for this agent');
  });
});

describe('AgentStatefulShellService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Agent,
      IAgentStatefulShell,
      AgentStatefulShellService,
      ScopeActivation.OnDemand,
      'os/backends',
    );
  });

  it('keeps one shell per agent scope and kills its live tasks when the scope is disposed', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'stateful-scope-wd-'));
    const sessionDir = mkdtempSync(join(tmpdir(), 'stateful-scope-session-'));
    try {

      const info = await probeHostEnvironmentFromNode();
      const host = createScopedTestHost([
        stubPair(IHostEnvironment, {
          _serviceBrand: undefined,
          ...info,
          ready: Promise.resolve(),
        } satisfies IHostEnvironment),
        stubPair(
          ISessionContext,
          makeSessionContext({
            sessionId: 's',
            workspaceId: 'w',
            sessionDir,
            sessionScope: 'sessions/w/s',
            cwd: workDir,
          }),
        ),
        stubPair(IAgentRuntimeService, {
          _serviceBrand: undefined,
          onDidChange: () => ({ dispose: () => {} }),
          inspect: () => {
            throw new Error('no runtime in this test');
          },
          isAvailable: () => false,
          acquire: () => {
            throw new Error('no runtime in this test');
          },
        } satisfies IAgentRuntimeService),
      ]);
      const session = host.child(LifecycleScope.Session, 's');
      const agentOne = host.childOf(session, LifecycleScope.Agent, 'agent-1', [
        stubPair(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'agent-1', agentScope: 'sessions/w/s/agents/agent-1' }),
        ),
      ]);
      const agentTwo = host.childOf(session, LifecycleScope.Agent, 'agent-2', [
        stubPair(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'agent-2', agentScope: 'sessions/w/s/agents/agent-2' }),
        ),
      ]);

      const shellOne = agentOne.accessor.get(IAgentStatefulShell);
      const shellTwo = agentTwo.accessor.get(IAgentStatefulShell);
      expect(shellOne).not.toBe(shellTwo);

      const sleeper = await shellOne.runTask({ command: 'sleep 60', background: true });
      const wait = sleeper.wait();
      agentOne.dispose();
      await expect(wait).resolves.toBeDefined();

      expect(await shellTwo.runTask({ command: 'echo alive', background: true })).toBeDefined();
      host.dispose();
    } finally {

      for (const dir of [workDir, sessionDir]) {
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            rmSync(dir, { recursive: true, force: true });
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
      }
    }
  }, 60_000);
});

interface StatefulFixture {
  readonly shell: IAgentStatefulShell;
  readonly tool: BashTool;
  readonly tasks: IAgentTaskService;
  readonly snapshotDir: string;
  readonly sessionDir: string;
  readonly workDir: string;
  readonly disposables: DisposableStore;
}

describe('BashTool with IAgentStatefulShell (real bash)', () => {
  let savedHome: string | undefined;

  beforeAll(() => {
    savedHome = process.env['HOME'];
    process.env['HOME'] = mkdtempSync(join(tmpdir(), 'stateful-home-'));
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
  });

  async function createStatefulFixture(
    options: { autoBackgroundOnTimeout?: boolean } = {},
  ): Promise<StatefulFixture> {
    const info = await probeHostEnvironmentFromNode();
    const env: IHostEnvironment = {
      _serviceBrand: undefined,
      ...info,
      ready: Promise.resolve(),
    };
    const workDir = mkdtempSync(join(tmpdir(), 'stateful-wd-'));
    const sessionDir = mkdtempSync(join(tmpdir(), 'stateful-session-'));
    const snapshotDir = join(sessionDir, 'agents', 'main', 'shell-state');
    const disposables = new DisposableStore();
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IHostEnvironment, env);
        reg.defineInstance(
          ISessionContext,
          makeSessionContext({
            sessionId: 's',
            workspaceId: 'w',
            sessionDir,
            sessionScope: 'sessions/w/s',
            cwd: workDir,
          }),
        );
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: 'sessions/w/s/agents/main' }),
        );

        reg.defineInstance(IHostProcessService, {
          _serviceBrand: undefined,
          spawn: vi.fn(async () => {
            throw new Error('one-shot runner must not be used in stateful mode');
          }),
        } as unknown as IHostProcessService);
        reg.define(IAgentStatefulShell, AgentStatefulShellService);
      },
    });

    const shell = ix.get(IAgentStatefulShell);
    const tasks = createFakeTaskService().service;
    const tool = bashTool(
      ix.get(IHostProcessService),
      env,
      ix.get(ISessionContext),
      tasks,
      stubToolPolicy(),
      stubConfig({
        bash: { stateful: true },
        task: { bashAutoBackgroundOnTimeout: options.autoBackgroundOnTimeout ?? true },
      }),
      shell,
    );
    return { shell, tool, tasks, snapshotDir, sessionDir, workDir, disposables };
  }

  async function disposeFixture(fixture: StatefulFixture): Promise<void> {
    await fixture.shell.closeShell();
    fixture.disposables.dispose();

    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        rmSync(fixture.workDir, { recursive: true, force: true });
        rmSync(fixture.sessionDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    rmSync(fixture.workDir, { recursive: true, force: true });
    rmSync(fixture.sessionDir, { recursive: true, force: true });
  }

  function runFg(
    fixture: StatefulFixture,
    command: string,
    args: Partial<BashRunInput> = {},
  ): Promise<ExecutableToolResult> {
    return executeTool(fixture.tool, context({ command, timeout: 60, ...args }));
  }

  it('persists exported vars, unexported vars, cwd, and functions across calls', async () => {
    const fixture = await createStatefulFixture();
    try {
      const first = await runFg(
        fixture,
        'export FOO_EXPORTED=bar; UNEXPORTED_VAR=qux; cd /; persist_fn() { echo fn-alive; }; echo setup-done',
      );
      expect(first).toMatchObject({ isError: false });

      const user = await runFg(fixture, 'echo "[$(pwd)]"', { userInitiated: true });
      expect(user).toMatchObject({ isError: false });
      expect(user.output).toContain('[/]');

      const workDirName = fixture.workDir.split(/[\\/]/).pop()!;
      const second = await runFg(
        fixture,
        'echo "[$FOO_EXPORTED][$UNEXPORTED_VAR][$(basename "$(pwd)")]"; persist_fn',
      );
      expect(second).toMatchObject({ isError: false });
      expect(second.output).toContain(`[bar][qux][${workDirName}]`);
      expect(second.output).toContain('fn-alive');
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it('rolls back cd/export of a failing (exit 1) call', async () => {
    const fixture = await createStatefulFixture();
    try {
      await runFg(fixture, 'export FOO_KEEP=1; echo committed');
      const failed = await runFg(fixture, 'export FOO_KEEP=2; cd /; exit 1');
      expect(failed).toMatchObject({ isError: true });

      const check = await runFg(fixture, 'echo "[$FOO_KEEP][$(basename "$(pwd)")]"');
      const workDirName = fixture.workDir.split(/[\\/]/).pop()!;
      expect(check.output).toContain(`[1][${workDirName}]`);
      expect(check.output).not.toContain('[2]');
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it('stays responsive when a foreground task is detached to background, and never commits its state', async () => {
    const fixture = await createStatefulFixture();
    try {
      const workDirName = fixture.workDir.split(/[\\/]/).pop()!;

      const sleeper = await fixture.shell.runTask({ command: 'cd / && sleep 2', background: false });
      sleeper.detachToBackground?.();

      const responsive = await fixture.shell.runTask({ command: 'echo alive', background: false });
      expect(await responsive.wait()).toBe(0);
      await responsive.dispose();

      expect(await sleeper.wait()).toBe(0);
      await sleeper.dispose();
      const check = await fixture.shell.runTask({
        command: 'basename "$(pwd)"',
        background: false,
      });
      let cwd = '';
      check.stdout.on('data', (chunk: Buffer | string) => {
        cwd += String(chunk);
      });
      expect(await check.wait()).toBe(0);
      await check.dispose();
      expect(cwd).toContain(workDirName);
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  describe('state change note', () => {
    const lastNonEmptyLine = (output: string): string =>
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1) ?? '';

    it('never reports a cwd change, and the committed cwd steers only the user shell', async () => {
      const fixture = await createStatefulFixture();
      try {
        mkdirSync(join(fixture.workDir, 'state-sub'));

        const before = await runFg(fixture, 'pwd');
        expect(before).toMatchObject({ isError: false });
        const oldCwd = lastNonEmptyLine(before.output as string);

        const cd = await runFg(fixture, 'cd state-sub && pwd');
        expect(cd).toMatchObject({ isError: false });
        expect(cd.output).toContain(`${oldCwd}/state-sub`);
        expect(cd.output).not.toContain('[bash state]');

        const user = await runFg(fixture, 'echo "[$(pwd)]"', { userInitiated: true });
        expect(user).toMatchObject({ isError: false });
        expect(user.output).toContain('state-sub');

        const agent = await runFg(fixture, 'pwd');
        expect(agent).toMatchObject({ isError: false });
        expect(lastNonEmptyLine(agent.output as string)).toBe(oldCwd);
      } finally {
        await disposeFixture(fixture);
      }
    }, 60_000);

    it('reports a conda env change directly, without the conda-internal var noise', async () => {
      const fixture = await createStatefulFixture();
      try {
        const defineFake = await runFg(
          fixture,
          'conda() { if [[ "$1" == activate ]]; then export CONDA_DEFAULT_ENV="$2" CONDA_PREFIX="/fake/$2" CONDA_SHLVL=1; export PATH="/fake/$2/bin:$PATH"; else unset CONDA_DEFAULT_ENV CONDA_PREFIX CONDA_SHLVL; fi; }',
        );
        expect(defineFake).toMatchObject({ isError: false });

        expect(defineFake.output).not.toContain('[bash state]');

        await runFg(fixture, 'unset CONDA_DEFAULT_ENV CONDA_PREFIX CONDA_SHLVL');

        const activated = await runFg(fixture, 'conda activate bsa');
        expect(activated).toMatchObject({ isError: false });
        expect(activated.output).toContain('[bash state] conda=bsa');
        expect(activated.output).not.toContain('CONDA_PREFIX');
        expect(activated.output).not.toContain('CONDA_SHLVL');
        expect(activated.output).not.toContain('~PATH');

        const switched = await runFg(fixture, 'conda activate gpu');
        expect(switched).toMatchObject({ isError: false });
        expect(switched.output).toContain('[bash state] conda=gpu');

        const deactivated = await runFg(fixture, 'conda deactivate');
        expect(deactivated).toMatchObject({ isError: false });
        expect(deactivated.output).toContain('[bash state] conda=none');
        expect(deactivated.output).not.toContain('CONDA_PREFIX');
      } finally {
        await disposeFixture(fixture);
      }

    }, 90_000);

    it('emits no state note for a failing command and rolls back its cd', async () => {
      const fixture = await createStatefulFixture();
      try {
        const before = await runFg(fixture, 'pwd');
        expect(before).toMatchObject({ isError: false });
        const oldCwd = lastNonEmptyLine(before.output as string);

        const failed = await runFg(fixture, 'cd / && false');
        expect(failed).toMatchObject({ isError: true });
        expect(failed.output).not.toContain('[bash state]');

        const after = await runFg(fixture, 'pwd');
        expect(after).toMatchObject({ isError: false });
        expect(after.output).toContain(oldCwd);
      } finally {
        await disposeFixture(fixture);
      }
    }, 30_000);
  });

  describe('durable state replay', () => {

    const stateFile = (fixture: StatefulFixture): string =>
      join(fixture.snapshotDir, 'shell-state.state');
    const varsFile = (fixture: StatefulFixture): string =>
      join(fixture.snapshotDir, 'shell-state.vars');
    const funcsFile = (fixture: StatefulFixture): string =>
      join(fixture.snapshotDir, 'shell-state.funcs');

    it('restores committed state after a shell restart', async () => {
      const fixture = await createStatefulFixture();
      try {
        mkdirSync(join(fixture.workDir, 'state-sub'));
        const commit = await runFg(fixture, 'cd state-sub && export KIMI_RESTORE_VAR=1');
        expect(commit).toMatchObject({ isError: false });

        expect(commit.output).toContain('[bash state] env: +KIMI_RESTORE_VAR');
        expect(commit.output).not.toContain('cwd=');

        await fixture.shell.closeShell();

        const check = await runFg(fixture, 'echo "[$KIMI_RESTORE_VAR][$(pwd)]"', {
          userInitiated: true,
        });
        expect(check).toMatchObject({ isError: false });
        expect(check.output).toContain('/state-sub');
        expect(check.output).toContain('[1]');

        expect(check.output).not.toContain('[bash state]');
      } finally {
        await disposeFixture(fixture);
      }
    }, 60_000);

    it('restores a conda activation after a shell restart', async () => {
      const fixture = await createStatefulFixture();
      try {
        await runFg(
          fixture,
          'conda() { if [[ "$1" == activate ]]; then export CONDA_DEFAULT_ENV="$2" CONDA_PREFIX="/fake/$2" CONDA_SHLVL=1; export PATH="/fake/$2/bin:$PATH"; else unset CONDA_DEFAULT_ENV CONDA_PREFIX CONDA_SHLVL; fi; }',
        );

        await runFg(fixture, 'unset CONDA_DEFAULT_ENV CONDA_PREFIX CONDA_SHLVL');
        const activated = await runFg(fixture, 'conda activate bsa');
        expect(activated).toMatchObject({ isError: false });
        expect(activated.output).toContain('[bash state] conda=bsa');

        await fixture.shell.closeShell();

        const check = await runFg(fixture, 'echo "$CONDA_DEFAULT_ENV"; declare -F conda');
        expect(check).toMatchObject({ isError: false });
        expect(check.output).toContain('bsa');
        expect(check.output).toContain('conda');

        expect(check.output).not.toContain('[bash state]');
        expect(check.output).not.toContain('conda=bsa');
      } finally {
        await disposeFixture(fixture);
      }
    }, 120_000);

    it('does not rewrite the durable state on a no-op commit', async () => {
      const fixture = await createStatefulFixture();
      try {
        await runFg(fixture, 'export KIMI_DURABLE_VAR=1');

        const stateMtimeBefore = statSync(stateFile(fixture)).mtimeMs;
        const varsMtimeBefore = statSync(varsFile(fixture)).mtimeMs;
        const funcsMtimeBefore = statSync(funcsFile(fixture)).mtimeMs;

        const noop = await runFg(fixture, 'true');
        expect(noop).toMatchObject({ isError: false });
        expect(statSync(stateFile(fixture)).mtimeMs).toBe(stateMtimeBefore);
        expect(statSync(varsFile(fixture)).mtimeMs).toBe(varsMtimeBefore);
        expect(statSync(funcsFile(fixture)).mtimeMs).toBe(funcsMtimeBefore);
      } finally {
        await disposeFixture(fixture);
      }
    }, 60_000);

    it('reports a replay failure but still starts', async () => {
      const fixture = await createStatefulFixture();
      try {
        await runFg(fixture, 'export KIMI_REPLAY_VAR=1');

        writeFileSync(stateFile(fixture), 'cd /definitely-not-a-real-dir-xyz\n');

        await fixture.shell.closeShell();

        const check = await runFg(fixture, 'pwd');
        expect(check).toMatchObject({ isError: false });
        expect(check.output).toContain('[bash state] replay failed');
        expect(check.output).toContain('stateful-wd-');
      } finally {
        await disposeFixture(fixture);
      }
    }, 60_000);
  });

  it('never commits state from background calls', async () => {
    const fixture = await createStatefulFixture();
    try {
      const started = await runFg(fixture, 'export BG_VAR=hello; echo bg-done', {
        run_in_background: true,
        description: 'bg state test',
      });
      expect(started).toMatchObject({ isError: false });
      const taskId = /^task_id: (\S+)/m.exec(started.output as string)?.[1];
      expect(taskId).toBeDefined();
      await fixture.tasks.wait(taskId!);

      const check = await runFg(fixture, 'echo "BG_VAR=[$BG_VAR]"');
      expect(check.output).toContain('BG_VAR=[]');
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);

  it('keeps the committed state alive after a timeout kill', async () => {
    const fixture = await createStatefulFixture({ autoBackgroundOnTimeout: false });
    try {
      await runFg(fixture, 'export BEFORE_KILL=yes; echo committed');

      const killed = await runFg(fixture, 'export AFTER_KILL=no; sleep 30', { timeout: 1 });
      expect(killed).toMatchObject({ isError: true });
      expect(killed.output as string).toContain('killed by timeout');

      const check = await runFg(fixture, 'echo "[$BEFORE_KILL][$AFTER_KILL]"');
      expect(check.output).toContain('[yes][]');
    } finally {
      await disposeFixture(fixture);
    }
  }, 30_000);
});
