Shadow mode is active. Your execution environment is now the LOCAL machine of the user, rooted at the shadow workdir below — NOT the session's original (e.g. remote ssh) workspace.

- Read, Write, Edit, Glob, Grep, and Bash all operate on local files under the shadow workdir. Paths outside it are rejected; the original workspace is untouched.
- The original tool state (shell cwd, variables, functions) has been checkpointed and will be restored when you exit.
- Background tasks you start now run locally and will be stopped on exit; the local shadow shell state is destroyed on exit.
- MCP tools still run against the original workspace.

When you no longer need local access, call ExitShadowMode. It needs no user approval and ends with the original environment restored.
