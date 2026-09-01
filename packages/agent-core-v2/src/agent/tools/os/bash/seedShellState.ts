import { join } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

const SNAPSHOT_FILES = ['shell-state.state', 'shell-state.vars', 'shell-state.funcs'] as const;

export async function seedShellStateFromParent(args: {
  readonly fs: IHostFileSystem;
  readonly parentAgentId: string;
  readonly childAgentId: string;
  readonly sessionDir: string;
}): Promise<void> {
  const snapshotDir = (agentId: string): string =>
    join(args.sessionDir, 'agents', agentId, 'shell-state');
  const parentDir = snapshotDir(args.parentAgentId);
  const existing: string[] = [];
  for (const name of SNAPSHOT_FILES) {
    const path = join(parentDir, name);
    const present = await args.fs
      .stat(path)
      .then(() => true)
      .catch(() => false);
    if (present) existing.push(name);
  }
  if (existing.length === 0) return;
  const childDir = snapshotDir(args.childAgentId);
  await args.fs.mkdir(childDir, { recursive: true });
  for (const name of existing) {
    await args.fs.writeBytes(join(childDir, name), await args.fs.readBytes(join(parentDir, name)));
  }
}
