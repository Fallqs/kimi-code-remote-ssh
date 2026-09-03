# SSH remote sessions

Kimi Code CLI can run a session whose working directory lives on a remote host, reached over SSH. Everything — the interface, the agent engine, session storage, and LLM calls — runs locally; only tool execution (file operations and spawned processes) happens on the remote machine. This page covers enabling the feature, connecting with an `ssh://` spec, how your OpenSSH setup is used, what runs where, disconnect handling, current limitations, and troubleshooting.

> SSH workspaces are experimental and off by default. Enable the `ssh-workdir` flag first: toggle it in the TUI's [`/experiments`](../reference/slash-commands.md) panel, set the `KIMI_CODE_EXPERIMENTAL_SSH_WORKDIR=1` environment variable, or add `ssh-workdir = true` under `[experimental]` in `config.toml`. With the flag off, an `ssh://` spec is rejected with a clear error.

## Connecting

Start an SSH session by passing an `ssh://` spec where you would normally pass a local directory. In the TUI, use [`/new`](./sessions.md#switching-sessions-inside-the-tui):

```sh
/new ssh://dev@gpu-box.example.com/work/project
```

The spec format is `ssh://[user@]host[:port]/path`, where `path` is an absolute POSIX path on the remote host. `/new` argument completion suggests local directories and recently used workdirs — past `ssh://` specs included — but never completes remote paths, so a new spec is typed manually. SSH sessions are stored and resumed like local ones; the connection details live in the session metadata, and no secrets are stored.

In the web UI, the Add Workspace dialog accepts an `ssh://` spec too: type it into the path box — the dialog shows an experimental hint — and confirm. The spec is validated server-side on add, and engine errors such as a failed connection surface inline in the dialog. The web composer's `!` bash mode also works on SSH workspaces; the command runs on the remote host.

## How the connection works

On first connect, the CLI probes the remote host through your system OpenSSH client and deploys the Remote Tool Server (RTS) there, in one of two flavors. When a prebuilt RTS binary for the remote platform is available locally — built from the repo with `pnpm --filter @moonshot-ai/remote-ssh build:sea`, or placed at `~/.kimi-code/sea/<platform>/rts-bin` next to an installed CLI — it is uploaded to `~/.kimi-code/remote-agent/rts-bin` and run directly — the remote host needs nothing installed. Otherwise the CLI deploys the RTS as a single-file Node.js program to `~/.kimi-code/remote-agent/rts.js` and runs it as `ssh <host> node rts.js`, which requires Node.js on the remote host. Either way, the server's stdio (the input/output channel of a process) becomes one multiplexed RPC (remote procedure call) pipe that carries every file operation and process spawn of that workspace.

The CLI redeploys automatically whenever the deployed bundle's version does not match, so upgrades need no manual cleanup. Because the transport is the system `ssh`, connection features such as jump hosts, agent forwarding, and connection sharing come from your own OpenSSH setup rather than from Kimi Code-specific configuration.

## SSH configuration and authentication

The host part of the spec can be a literal hostname or a `Host` alias from your OpenSSH client configuration (`~/.ssh/config`) — everything in that file applies, including `HostName`, `IdentityFile`, `ProxyJump` / `ProxyCommand`, ssh-agent, and `ControlMaster` connection sharing. An explicit `user@` or `:port` in the spec overrides the corresponding config value. Host key verification uses your regular `known_hosts` file (where OpenSSH records trusted host keys), so the first connection to a new host must happen outside the CLI, as described below.

The CLI always runs ssh with `BatchMode=yes`, which forbids interactive prompts: there is no way to type a password or accept an unknown host key from inside Kimi Code. Set up passwordless authentication (a key file or a running ssh-agent) beforehand, and pre-authorize the host key by running a normal `ssh <host>` once in your terminal. When a connection fails, ssh's own error output is included verbatim in the error message, which usually names the exact cause.

## Remote host requirements

The remote host must provide a POSIX environment with bash. With a prebuilt RTS binary available (see above) that is all it needs; without one, Node.js 20 or later must be on its `PATH` — the deploy step probes for it and fails with a clear error otherwise. ripgrep (`rg`) is optional: when it is absent, `Grep` falls back to a built-in JavaScript implementation.

## What runs where

All tool file and process execution is remote: `Read`, `Write`, `Edit`, `Glob`, and `Grep` operate on the remote filesystem, and `Bash` commands run on the remote host. Session persistence, transcripts, and plan-mode state stay local, so a session still resumes from your local machine.

There is one deliberate exception: plan documents and stateful-shell snapshots live on the execution side under `~/.kimi-code/remote-sessions/<sessionId>/`, so the model's `Write` tool and remote `Bash` can see them. This directory is removed automatically when the session is closed or deleted, on a best-effort basis.

## Stateful shell on the remote host

With [`stateful`](../configuration/config-files.md#bash) enabled under `[bash]`, the resuming shell runs on the remote host, and its snapshots are stored under the execution-side directory above. See [Stateful Bash](./stateful-bash.md) for what persists and the commit semantics.

## Interruptions and resuming

If the SSH connection drops, in-flight remote processes are killed — the RTS dies with the pipe and kills its process groups — and interrupted commands are never silently retried. A tool call that arrives while the connection is down triggers one reconnect attempt before running, and proceeds when that attempt succeeds instead of failing fast with a connection error.

The CLI also reconnects in the background. When the background reconnect finishes first, the environment stays blocked until you resume manually: run `/resume-remote` in the TUI, or call `POST /api/v1/workspaces/{id}/ssh/resume` over the REST API (the current state is readable from `GET /api/v1/workspaces/{id}/ssh/state`). The explicit acknowledge step keeps a flaky network from restarting half-finished work without your knowledge.

## Limitations

A few integrations are not remote yet; they are planned for a later phase.

- **File watching**: remote file watching is not available, so workspace file watching is inactive on SSH workspaces.
- **Git integration**: git status and diff still run locally and do not reflect the remote repository.
- **Single root**: an SSH workspace contains exactly the directory named in the spec; adding extra local directories (for example with `/add-dir`) does not apply.
- **Mixed platforms**: with a Windows local machine and a Linux remote, some paths may display in mixed formats.

## Troubleshooting

Connection failures almost always come from the remote environment or the local OpenSSH setup, and the ssh error output quoted in the message usually points at the cause.

- **`node: command not found` or a version error**: no prebuilt RTS binary was available, so the deploy fell back to the Node.js flavor — install Node.js 20 or later on the remote host's non-interactive `PATH`, or build the prebuilt binary (above) so no remote Node.js is needed.
- **Host key verification failed**: the host key is not yet trusted — run `ssh <host>` once in your terminal and accept the key there.
- **Permission denied**: `BatchMode=yes` forbids password prompts, so configure key-based authentication or a running ssh-agent.
- **Jump hosts**: configure `ProxyJump` or `ProxyCommand` in `~/.ssh/config`; the CLI picks it up through the system OpenSSH client.
- **Stale deployment**: the RTS lives under `~/.kimi-code/remote-agent/` on the remote host (`rts-bin` and/or `rts.js`) and is redeployed automatically on version mismatch; deleting it by hand is safe and simply triggers a redeploy on the next connect.

## Next steps

- [Sessions and context](./sessions.md) — how sessions are stored, resumed, and switched
- [Stateful Bash](./stateful-bash.md) — persist shell state across `Bash` calls
