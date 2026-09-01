import type { Readable, Writable } from 'node:stream';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface StatefulShellRunInput {
  readonly command: string;
  readonly cwd?: string;
  readonly background: boolean;
}

export interface StatefulShellProcess {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  wait(): Promise<number>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  dispose(): void | Promise<void>;
  detach(): Promise<void>;
  detachToBackground?(): void;
}

export interface IAgentStatefulShell {
  readonly _serviceBrand: undefined;

  runTask(input: StatefulShellRunInput): Promise<StatefulShellProcess>;
  closeShell(): Promise<void>;
}

export const IAgentStatefulShell: ServiceIdentifier<IAgentStatefulShell> =
  createDecorator<IAgentStatefulShell>('agentStatefulShell');
