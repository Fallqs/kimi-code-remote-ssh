import type {
  ResumingProc,
  ResumingShellEnv,
  ResumingShellFacts,
  ResumingShellFs,
  ResumingShellSpawnOptions,
} from '@moonshot-ai/kaos';

import type { Runtime } from '#/runtime/runtime';

export class RuntimeResumingShellEnv implements ResumingShellEnv {
  readonly facts: ResumingShellFacts = { shell: 'bash', windows: false };
  readonly fs: ResumingShellFs;

  constructor(private readonly runtime: Runtime) {
    const fs = runtime.fs;
    if (fs === undefined) throw new Error('runtime has no fs capability');
    this.fs = {
      readText: (path) => fs.readText(path),
      writeText: (path, text) => fs.writeText(path, text),
      mkdir: (path) => fs.mkdir(path, { recursive: true }),
      remove: (path) => fs.remove(path).catch(() => {}),
      exists: async (path) => {
        try {
          await fs.stat(path);
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
    const command = args[0];
    if (command === undefined) {
      throw new Error('RuntimeResumingShellEnv.spawn: empty argv');
    }
    const processService = this.runtime.process;
    if (processService === undefined) throw new Error('runtime has no process capability');
    return processService.spawn(command, args.slice(1), {
      cwd: options?.cwd,
      env: {
        NO_COLOR: '1',
        TERM: 'dumb',
        GIT_TERMINAL_PROMPT: '0',
        SHELL: command,
        ...options?.env,
      },
    });
  }
}
