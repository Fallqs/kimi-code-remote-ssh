import type { Readable, Writable } from 'node:stream';

import {
  LocalResumingShellEnv,
  ResumingShell,
  type ResumingShellEnv,
  type ResumingShellProcess,
} from '@moonshot-ai/kaos';
import { posix, join } from 'pathe';

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { RuntimeLease } from '#/runtime/runtime';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { remoteSessionDir } from '#/workspace/workspaceSsh/remoteSessionDir';

import { RuntimeResumingShellEnv } from './runtimeResumingShellEnv';

import {
  IAgentStatefulShell,
  type StatefulShellProcess,
  type StatefulShellRunInput,
} from './statefulShell';

export class AgentStatefulShellService extends Disposable implements IAgentStatefulShell {
  declare readonly _serviceBrand: undefined;

  private readonly shell: ResumingShell;
  private readonly runtimeLease: RuntimeLease | undefined;
  private taskCounter = 0;
  private _disposed = false;

  constructor(
    @ISessionContext ctx: ISessionContext,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IHostEnvironment hostEnv: IHostEnvironment,
    @IAgentRuntimeService runtimes?: IAgentRuntimeService,
  ) {
    super();
    if (ctx.remoteCwd !== undefined && runtimes !== undefined) {
      const lease = runtimes.acquire(['fs', 'process']);
      this.runtimeLease = lease;
      const rt = lease.runtime;
      const env: ResumingShellEnv = new RuntimeResumingShellEnv(rt);
      this.shell = new ResumingShell(env, {
        snapshotDir: posix.join(
          remoteSessionDir(rt.environment.homeDir, ctx.sessionId),
          'agents',
          scopeContext.agentId,
          'shell-state',
        ),
        initialCwd: ctx.remoteCwd,
        shellPath: rt.environment.shellPath,
      });
    } else {
      this.shell = new ResumingShell(new LocalResumingShellEnv(), {
        snapshotDir: join(ctx.sessionDir, 'agents', scopeContext.agentId, 'shell-state'),
        initialCwd: ctx.cwd,
        shellPath: hostEnv.shellPath,
      });
    }
    this._register(
      toDisposable(() => {
        this._disposed = true;
        this.runtimeLease?.dispose();
        void this.closeShell().catch(() => {});
      }),
    );
  }

  async runTask(input: StatefulShellRunInput): Promise<StatefulShellProcess> {
    if (this._disposed) throw new Error('stateful bash has been disposed');
    const id = `sh-${++this.taskCounter}`;
    const handle = await this.shell.runTask({
      id,
      command: input.command,
      cwd: input.cwd,
      background: input.background,
    });
    return new StatefulShellTaskHandle(handle);
  }

  async closeShell(): Promise<void> {
    await this.shell.dispose();
  }
}

class StatefulShellTaskHandle implements StatefulShellProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  constructor(private readonly proc: ResumingShellProcess) {
    this.stdin = proc.stdin;
    this.stdout = proc.stdout;
    this.stderr = proc.stderr;
  }

  get pid(): number {
    return this.proc.pid;
  }

  get exitCode(): number | null {
    return this.proc.exitCode;
  }

  wait(): Promise<number> {
    return this.proc.wait();
  }

  kill(_signal?: NodeJS.Signals): Promise<void> {
    return this.proc.kill();
  }

  detach(): Promise<void> {
    return this.proc.detach();
  }

  detachToBackground(): void {
    void this.proc.detach();
  }

  dispose(): void {
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentStatefulShell,
  AgentStatefulShellService,
  ScopeActivation.OnDemand,
  'os/backends',
);
