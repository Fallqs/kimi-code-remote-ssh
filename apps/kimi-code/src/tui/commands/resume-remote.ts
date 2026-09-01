import type { SlashCommandHost } from './dispatch';

/**
 * `/resume-remote` — the manual-resume affordance for ssh:// workspaces
 * (OQ-R3). An interrupted ssh pipe is re-established in the background but
 * stays `blocked` until the user acknowledges it here; every other state is
 * reported without action.
 */
export async function handleResumeRemoteCommand(host: SlashCommandHost): Promise<void> {
  const workDir = host.state.appState.workDir;
  const state = await host.harness.getWorkspaceSshConnectionState(workDir);
  if (state === undefined) {
    host.showStatus('The current workspace is not an ssh:// remote workspace.');
    return;
  }
  if (state === 'blocked') {
    const next = await host.harness.resumeWorkspaceSshConnection(workDir);
    host.showStatus(`Resumed the interrupted ssh connection (now ${next ?? 'unknown'}).`);
    return;
  }
  if (state === 'ready') {
    host.showStatus('The ssh connection is ready — nothing to resume.');
    return;
  }
  if (state === 'closed') {
    host.showStatus('The ssh connection is closed; reopen the workspace to reconnect.');
    return;
  }
  host.showStatus(`The ssh connection is ${state} — a reconnect is in progress; try again shortly.`);
}
