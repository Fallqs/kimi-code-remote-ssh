Shadow mode is active. Your execution environment is now the shadow target rooted at the workdir below — NOT the session's original workspace.

- Read, Write, Edit, Glob, Grep, and Bash all operate on files under the shadow workdir. Paths outside it are rejected; the original workspace is untouched.
- The original tool state (shell cwd, variables, functions) has been checkpointed and will be restored when you exit.
- Background tasks you start now run in the shadow environment and will be stopped on exit; the shadow shell state is destroyed on exit.
- MCP tools still run against the original workspace.

When you no longer need the shadow environment, call ExitShadowMode. It needs no user approval and ends with the original environment restored.
