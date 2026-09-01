Execute a `{{ SHELL_NAME }}` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.

**Translate these to a dedicated tool instead:**
- `cat` / `head` / `tail` (known path) → `Read`
- `sed` / `awk` (in-place edit) → `Edit`
- `echo > file` / `cat <<EOF` → `Write`
- `find` / recursive `ls` to locate files by name pattern → `Glob` (plain `ls <known-directory>` is fine for listing a directory)
- `grep` / `rg` (search file contents) → `Grep`
- `echo` / `printf` (talk to the user) → just output text directly

The dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.

**Output:**
The stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a `Command failed with exit code: N` line; a command killed by its timeout or interrupted by the user ends with its own message instead.

If `run_in_background=true`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. When doing that, you must provide a short `description`. Background commands default to a {{ DEFAULT_BACKGROUND_TIMEOUT_S }}s timeout and `timeout` is capped at {{ MAX_BACKGROUND_TIMEOUT_S }}s; set `disable_timeout=true` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Use `TaskOutput` only for a non-blocking status/output snapshot — do not wait on a task you just launched, since its completion arrives automatically. Use `TaskStop` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the `/tasks` command, which opens an interactive panel; it has no subcommands.

**Shell state (this shell is stateful):**
- Shell state is restored from a durable snapshot before each command and committed back after each successful foreground command: environment variables (exported or not), shell functions, activated environments such as conda, and the working directory all persist across calls. The state is shared with the human's `!` shell commands — their changes are visible to you, and your committed changes are visible to them.
- Each of your calls starts in the session's working directory: an omitted `cwd` does NOT inherit the snapshot's remembered directory (that belongs to the human's `!` commands). Pass the `cwd` argument or use `cd <path> && <command>` to work elsewhere; a plain `cd` in a successful foreground call still commits and steers the human's shell.
- State changes commit ONLY when a foreground call exits with code 0. Calls that exit non-zero, are killed, or time out roll back — their `cd`, `export`, and other state changes are discarded. Background calls never commit state.
- When a committed call changed the exported environment, the result carries a `[bash state] ...` line: `conda=<env>` / `conda=none` for a conda activation, switch, or deactivation, and `env: +A, ~B, -C` for the NAMES of exported variables added, changed, or removed — values are never shown, and cwd changes are never reported. No line means nothing changed. Committed state also survives a shell/server restart: the next command restores the last committed state, and a failed restore is reported as `[bash state] replay failed (...)`.
- A subagent's shell starts from the parent agent's snapshot as of the subagent's creation, then diverges — later commits on either side never propagate.
- Read/Write/Edit/Grep/Glob resolve relative paths against the session's working directory, independent of any shell state.

**Guidelines for safety and security:**
- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running foreground commands, set the `timeout` argument in seconds. Foreground commands default to {{ DEFAULT_TIMEOUT_S }}s and allow up to {{ MAX_TIMEOUT_S }}s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.
- Avoid using `..` to access files or directories outside of the working directory.
- Avoid modifying files outside of the working directory unless explicitly instructed to do so.
- Never run commands that require superuser privileges unless explicitly instructed to do so.

**Guidelines for efficiency:**
- Use `&&` to chain commands that genuinely depend on each other, e.g. `npm install && npm test`. Independent read-only commands (separate `git show`, `ls`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with `echo` separators.
- Use `;` to run commands sequentially regardless of success/failure
- Use `||` for conditional execution (run second command only if first fails)
- Use pipe operations (`|`) and redirections (`>`, `>>`) to chain input and output between commands
- Always quote file paths containing spaces with double quotes (e.g., cd "/path with spaces/")
- Compose multi-step logic in a single call with `if` / `case` / `for` / `while` control flows.
- Prefer `run_in_background=true` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.

**Commands available:**
The following common command categories are usually available. Availability still depends on the host, so when in doubt run `which <command>` first to confirm a command exists before relying on it.
- Navigation and inspection: `ls`, `pwd`, `cd`, `stat`, `file`, `du`, `df`, `tree`
- File and directory management: `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `chmod`, `chown`
- Text and data processing: `wc`, `sort`, `uniq`, `cut`, `tr`, `diff`, `xargs`
- Archives and compression: `tar`, `gzip`, `gunzip`, `zip`, `unzip`
- Networking and transfer: `curl`, `wget`, `ping`, `ssh`, `scp`
- Version control: `git`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the `gh` CLI when installed — it carries the user's GitHub auth and can return structured JSON
- Process and system: `ps`, `kill`, `top`, `env`, `date`, `uname`, `whoami`
- Language and package toolchains: `node`, `npm`, `pnpm`, `yarn`, `python`, `pip` (use whichever the project actually relies on)
