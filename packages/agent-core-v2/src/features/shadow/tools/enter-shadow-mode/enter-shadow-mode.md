Use this tool when your session is bound to a remote (ssh://) workspace but the task requires access to LOCAL files or local programs on the user's machine — remote agents cannot reach local paths by design.

Entering shadow mode forks the session at the turn boundary into a LOCAL session rooted at the local kimi home (`~/.kimi-code`), with the full conversation, todo list, and plan state intact:

- In the shadow session, Read, Write, Edit, Glob, Grep, and Bash operate on local files under that directory, and shell commands run locally.
- The current session is preserved untouched as the checkpoint — its remote tool state (shell cwd, variables, functions) is exactly what ExitShadowMode later restores.
- Background tasks started in the shadow session run locally and are destroyed with it on exit.

The tool call ends your current turn immediately; the fork and the host's session switch happen right after the turn ends. Do not call further tools after EnterShadowMode in the same turn.

Use it when ANY of these conditions apply:

1. Reading or modifying local files outside the remote workspace (e.g. local config, dotfiles, the kimi home itself)
2. Running a program that only exists on the local machine
3. Inspecting local state (processes, ports, local checkouts) to compare with the remote

When NOT to use:

- Ordinary work inside the remote workspace — stay in the normal environment

Permission mode notes:

- EnterShadowMode requests the switch without an approval prompt in all permission modes.
- ExitShadowMode exits shadow mode without asking the user: the shadow session's rows are merged back into the original session and the shadow session is discarded.
- Shadow mode is also available to agents on local workspaces, where the shadow session simply re-roots the workdir to the local kimi home.
