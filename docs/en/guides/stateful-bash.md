# Stateful Bash

By default each `Bash` tool call starts in a fresh shell, and nothing carries over to the next call. Stateful mode keeps shell state across calls by restoring it from a durable snapshot before each command and writing it back after a successful command. This page covers enabling it, what state persists, and how commits and rollbacks work.

## Enabling stateful mode

Set `stateful` to `true` under `[bash]` in `config.toml` (the default is `false`):

```toml
[bash]
stateful = true
```

## What persists

With stateful mode on, each command still runs in a fresh shell process, but its state is restored from a snapshot saved per agent before the command starts: environment variables (exported or not), the current working directory, shell function definitions, umask, and activated environments such as conda or venv. A typical use is running `conda activate myenv` once and having every later call execute inside that environment. Aliases, `set -o` options, and traps do not persist.

The state is shared between the agent's `Bash` calls and your own `!` shell commands, with one asymmetry: agent calls always start in the session's working directory (or the `cwd` argument), while your `!` commands start in the remembered working directory. A committed `cd` from either side still persists, so a `!` command lands where the last committed call left off — handy for inspecting directories the agent was working in.

The snapshot is stored on disk, so committed state survives a CLI restart and is picked up by the next command.

## Commit semantics

State changes follow commit semantics: a foreground call writes its changes back to the snapshot only when it exits with code 0. A call that exits non-zero, is killed, or times out rolls back — its `cd`, `export`, and other state changes are discarded. Background `Bash` calls restore the snapshot read-only and never commit, so they cannot change persisted state. The `cwd` argument sets a call's starting directory; when that call commits, the directory becomes the persisted working directory, exactly like a successful `cd`.

After a committed call that changed the exported environment, the output carries a `[bash state]` note — for example `[bash state] conda=myenv; env: +MY_FLAG`. It reports names only: the activated conda environment, and added (`+A`), changed (`~B`), or removed (`-C`) variables — never values, which may contain secrets. Working-directory changes are not reported; run `pwd` when you need the current directory.

If restoring the snapshot fails — for example the saved working directory no longer exists — the command starts from a cold shell and prints `[bash state] replay failed (...)`.

## Next steps

- [Config files](../configuration/config-files.md) — the configuration file reference
- [Tools](../reference/tools.md) — the `Bash` tool's foreground and background modes
