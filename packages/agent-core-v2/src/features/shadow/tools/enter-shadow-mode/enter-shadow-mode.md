Use this tool when your session is bound to one workspace but the task requires access to files or programs in ANOTHER environment — most commonly when a remote (ssh://) session needs access to LOCAL files or local programs on the user's machine, which remote agents cannot reach by design.

Entering shadow mode forks the session at the turn boundary into a session rooted at the shadow target, with the full conversation, todo list, and plan state intact. The optional `path` argument selects the target:

- omitted: the local kimi home (`~/.kimi-code`) on the user's machine
- an absolute local path (`~` is expanded): any directory on the local machine
- an `ssh://[user@]host[:port]/abs/path` spec: a directory on another remote host (requires the `ssh-workdir` experimental flag, e.g. `KIMI_CODE_EXPERIMENTAL_SSH_WORKDIR=1`)

In the shadow session:

- Read, Write, Edit, Glob, Grep, and Bash operate on files under the shadow target, and shell commands run there.
- The current session is preserved untouched as the checkpoint — its tool state (shell cwd, variables, functions) is exactly what ExitShadowMode later restores.
- Background tasks started in the shadow session run in the shadow environment and are destroyed with it on exit.

The tool call ends your current turn immediately; the fork and the host's session switch happen right after the turn ends. Do not call further tools after EnterShadowMode in the same turn.

Use it when ANY of these conditions apply:

1. Reading or modifying files outside the current workspace (e.g. local config, dotfiles, the kimi home itself, or a directory on another remote host)
2. Running a program that only exists in the target environment
3. Inspecting target-environment state (processes, ports, checkouts) to compare with the current workspace

When NOT to use:

- Ordinary work inside the current workspace — stay in the normal environment

Permission mode notes:

- EnterShadowMode requests the switch without an approval prompt in all permission modes.
- ExitShadowMode exits shadow mode without asking the user: the shadow session's rows are merged back into the original session and the shadow session is discarded.
- Shadow mode is also available to agents on local workspaces, where the shadow session simply re-roots the workdir to the target path.
