You are in $GOTO_WORKDIR.

Your execution environment is now that directory — NOT the session's original workspace, which stays untouched.

- Read, Write, Edit, Glob, Grep, and Bash all operate on files under the workdir above. Paths outside it are rejected.
- The original tool state (shell cwd, variables, functions) has been checkpointed and will be restored when you leave.
- Background tasks you start now run in the GOTO environment and will be stopped on GOBACK; the GOTO shell state is destroyed on GOBACK.
- MCP tools still run against the original workspace.

When you no longer need the GOTO environment, call GOBACK. It needs no user approval and ends with the original environment restored.
