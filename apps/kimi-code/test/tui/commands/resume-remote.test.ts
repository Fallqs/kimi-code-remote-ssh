import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/index';
import { handleResumeRemoteCommand } from '#/tui/commands/resume-remote';
import type { WorkspaceSshConnectionState } from '@moonshot-ai/kimi-code-sdk';

function makeHost(options: {
  state: WorkspaceSshConnectionState | undefined;
  resumedTo?: WorkspaceSshConnectionState;
}) {
  const host = {
    state: { appState: { workDir: 'ssh://dev.example.com/srv/app' } },
    harness: {
      getWorkspaceSshConnectionState: vi.fn(async (_workDir: string) => options.state),
      resumeWorkspaceSshConnection: vi.fn(
        async (_workDir: string) => options.resumedTo ?? options.state,
      ),
    },
    showStatus: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      getWorkspaceSshConnectionState: ReturnType<typeof vi.fn>;
      resumeWorkspaceSshConnection: ReturnType<typeof vi.fn>;
    };
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  return host;
}

describe('resume-remote slash command', () => {
  it('is registered as an always-available built-in', () => {
    const command = findBuiltInSlashCommand('resume-remote');
    expect(command).toBeDefined();
    expect(resolveSlashCommandAvailability(command!, '')).toBe('always');
  });

  it('reports a non-ssh workspace without calling resume', async () => {
    const host = makeHost({ state: undefined });
    await handleResumeRemoteCommand(host);
    expect(host.showStatus).toHaveBeenCalledWith(
      'The current workspace is not an ssh:// remote workspace.',
    );
    expect(host.harness.resumeWorkspaceSshConnection).not.toHaveBeenCalled();
  });

  it('resumes a blocked connection and reports the resulting state', async () => {
    const host = makeHost({ state: 'blocked', resumedTo: 'ready' });
    await handleResumeRemoteCommand(host);
    expect(host.harness.resumeWorkspaceSshConnection).toHaveBeenCalledWith(
      'ssh://dev.example.com/srv/app',
    );
    expect(host.showStatus).toHaveBeenCalledWith(
      'Resumed the interrupted ssh connection (now ready).',
    );
  });

  it('does not resume an already-ready connection', async () => {
    const host = makeHost({ state: 'ready' });
    await handleResumeRemoteCommand(host);
    expect(host.harness.resumeWorkspaceSshConnection).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'The ssh connection is ready — nothing to resume.',
    );
  });

  it('reports an in-flight reconnect without resuming', async () => {
    const host = makeHost({ state: 'reconnecting' });
    await handleResumeRemoteCommand(host);
    expect(host.harness.resumeWorkspaceSshConnection).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'The ssh connection is reconnecting — a reconnect is in progress; try again shortly.',
    );
  });
});
