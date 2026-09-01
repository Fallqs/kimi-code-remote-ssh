# stateful-shell

> One bash process per command whose state (variables incl. unexported ones, functions incl. conda activation, cwd, umask) persists across Bash tool calls — restored from and committed to a durable snapshot, with no persistent shell process.

The core (`src/stateful-shell/resuming.ts`) is environment-agnostic: ALL machine access goes through the `ResumingShellEnv` it is constructed with (spawn + a minimal fs + os/shell facts) — no `node:fs` / `node:child_process` and no `Kaos` reference. `LocalResumingShellEnv` is the local node implementation; the ssh-workdir plan's remote RTS implementation has the same shape.

## The resuming model

Each Bash tool call = one fresh bash process spawned directly through the execution environment, running a generated wrapper script (`buildResumingWrapperScript`). The script is **task-agnostic** — everything task-specific rides a single stdin frame — and runs in two phases:

```
phase 1   : history off → define dump/absorb/note/epilogue functions →
  (preamble)  source bashrc (with conda hook probe) → defensive initial cd →
            __kimi_absorb $SNAP (restore last commit; on failure emit a
            `[bash state] replay failed (<detail>)` stderr notice and
            continue cold) → BLOCK on one stdin frame line
frame     : TASK_ID \t FG(0|1) \t CWD_BASE64|`-` \t COMMAND_BASE64  (+ '\n';
            `-` = no tool-requested cwd; then stdin is EOF for the command)
phase 2   : decode the frame (base64 only when present) → sweep stale
  (hand-off)  commit flags (fg wrappers only) → cd to (tool cwd argument ??
            absorb-restored PWD), `cd || exit 1` on a stale target →
            capture pre-state (filtered export -p snapshot, for the
            state-note diff; fg only) → install the EXIT trap
body      : eval <base64-decoded user command>      (stdin = EOF, as today)
epilogue  : single EXIT trap: ec=$?
            if fg and <taskId>.commit-ok exists and ec=0 →
              __kimi_state_note (conda / env: +A, ~B, -C — NAMES only,
              never values; cwd changes are deliberately not reported) →
              __kimi_dump_state → atomic tmp+rename with a
              builtin string-compare skip (a no-op commit costs zero durable
              writes; the skipped .tmp files are left for the next dump's
              `>` truncation, so no cmp/rm spawns remain)
            → [bash state] <note> printed to stderr after a commit
            → exit $ec
```

- The process is a direct child of the execution environment: stdout/stderr are real pipes (local = node pipes; remote = RTS frame stream), the exit code comes from `wait()`, and kill is the existing two-stage tree kill (POSIX process-group `SIGTERM` → grace → `SIGKILL`; Windows `taskkill /T /F`). **No polling, no protocol frames, no outfiles, no positioned reads.**
- Script delivery: the generic script is written once per spawn to `<snapshotDir>/wrappers/<taskId-or-standby-N>.sh` via `env.fs.writeText` and spawned as `bash <script>` (posix-converted on Windows) — `bash -s` cannot work because bash would buffer frame bytes from the same stdin it reads the program from. Stdin therefore carries exactly the one frame line; the command itself is base64 inside the frame (no quoting / ARG_MAX issues). Script files are removed best-effort once their process has exited (bash reads scripts incrementally, so a file must outlive its process).
- Commit gate: each fg task creates `<taskId>.commit-ok` in the snapshot dir BEFORE the hand-off (with a standby, "spawn" already happened — the flag only has to precede the frame); `kill(id)` / `detach(id)` remove it BEFORE the process can exit-commit (a running process cannot edit its own script, so the epilogue's dump is gated on the flag file). The wrapper's trap removes its own flag on exit; a crashed run (SIGKILL, harness death) leaves it behind and the next foreground wrapper's sweep deletes it.
- bg tasks: the wrapper still absorbs the snapshot (read-only — equivalent to the old "bg fork inherits tip state"), but no commit flag → never commits.
- Concurrency: a per-shell **fg mutex** (TS side). The old design serialized implicitly (single tip); the new design queues explicitly to preserve "the next command sees the previous command's state". `detach` frees the fg slot immediately (the detached task is bg — it can never commit); bg concurrency is unrestricted. Snapshot writes are atomic (tmp+rename), so a bg absorb always reads a consistent version.

## The standby wrapper

The expensive part of a task is its wrapper's phase 1 (spawn + bashrc + conda probe + absorb — ~1.5 s on Windows Git Bash, ~50 ms on Linux), and it does not depend on the task. So the shell keeps ONE idle **standby**: a generic wrapper pre-spawned and blocked on the phase-1 frame read, its preamble already paid off the critical path. `runTask` hands the next command to it (commit flag first for fg, then the one frame line — critical path ≈ 0); with no usable standby it spawns on demand (the cold path: write script, spawn, write the frame immediately — same cost as before).

A standby is only valid for the snapshot version it absorbed, and the ONLY writer of the durable snapshot is an fg task exiting 0 with its commit flag, so validity is maintained by three rules:

1. **After every fg task that exits 0** (commit or no-op commit): kill any idle standby and spawn a fresh one — the fresh preamble absorbs the just-committed snapshot. The respawn happens in the background at settle time, off the critical path.
2. **After a non-zero fg exit** (rollback — the durable snapshot is byte-untouched): the idle standby is still valid — keep it.
3. **A bg task consuming the standby** never commits, so the snapshot the next standby must absorb cannot move: replenish immediately at hand-off.

A standby that died before use is discarded and `runTask` falls back to the on-demand cold path. `kill(id)` / `detach(id)` never touch the idle standby; `dispose()` (shell teardown) kills every live task AND the standby.

## Preserved user-visible contract

- **State coverage**: variables (including unexported), functions, cwd, umask (aliases / `set -o` / traps migrate in neither model).
- **Commit / rollback**: the snapshot lands only for fg && exit 0; non-zero exit, `exec` replacement, SIGKILL, or a clobbered EXIT trap → no commit (the old REAPED degradation).
- **Whole-snapshot conda restore** (hard requirement): the dump IS the post-activation state — conda vars, the `conda` function, PATH, cwd — so no re-activation is needed on restore.
- **`[bash state]` note**: `conda=…|none; env: +A, ~B, -C` — names only, never values (secrets must not reach transcripts). cwd changes are deliberately NOT reported (the note lands in chat history, where a moving cwd confuses agents; users can always `pwd`). Printed to the committing task's stderr.
- **`replay failed (<detail>)` notice**: an absorb failure (non-zero exit or any stderr, e.g. a stale `cd` target) degrades to a cold start with a visible stderr notice.
- **Snapshot location**: `<snapshotDir>/shell-state.{state,vars,funcs}` — local = `<sessionDir>/agents/<agentId>/shell-state` (v2) / `<agentHome>/shell-state` (v1); remote = execution-side home (snapshots embed machine-specific absolute paths and must live on the executing machine).
- **Subagent seeding (fork-on-create)**: when a subagent is created, the engine copies the parent agent's committed snapshot — only the three `shell-state.*` files, never `wrappers/`, commit flags, or `*.tmp` — into the child's own snapshot dir exactly once, so the child's first command starts from the parent's committed state (conda env, exports, functions) instead of cold. After the copy the two snapshots are fully independent: later commits never propagate in either direction, and resumed agents are never re-seeded.
- **Zero-disk-write no-op commits**: a builtin string compare (`[[ "$(<tmp)" == "$(<cur)" ]]`) before the rename preserves the durable mtime on unchanged state — no `cmp`/`rm` spawns on the commit hot path.

## The state filter

Variables that must never be dumped or unset during absorb — bash's bookkeeping variables — are excluded by `__KIMI_KEEPVARS_RE`, which is GENERATED, not hand-maintained: `pnpm --filter @moonshot-ai/kaos gen:shell-state-filter` (`scripts/gen-shell-state-filter.mts`) probes an isolated bash (readonly via declare flags, volatile via two captures straddling a `sleep 1` plus forced PRNG/`=~` references and a distinctive pipeline, lazy/function-context via a probe function in a deeper subshell; pre-declared-but-unset dynamics like `SECONDS`/`COMP_WORDBREAKS` count as volatile), self-verifies that two filtered commit/absorb cycles are byte-identical, and commits the result as `src/stateful-shell/shellStateFilter.generated.ts`. The drift check `test/shell-state-filter.test.ts` re-runs the detection and fails when the committed artifact no longer matches the live bash — regenerate then. The only hand-written part of the regex is the protocol's own `__kimi_*` / `__KIMI_*` prefix.

## The `ResumingShellEnv` contract

`ResumingShell` is constructed with an env and `{ snapshotDir, initialCwd, shellPath? }`:

- `spawn(argv, { cwd?, env? })` → `ResumingProc` (`{ stdin, stdout, stderr, pid, exitCode, wait(), kill(signal?) }`).
- `fs` — a minimal surface: `readText`, `writeText`, `mkdir`, `remove`, `exists`. No listing primitive by design (the wrapper's bash side does the stale-flag sweep).
- `facts` — `{ shell: 'bash', windows }`: the shell to spawn and whether paths embedded in the wrapper need posix conversion (Windows → Git Bash) and kills go through taskkill.

`LocalResumingShellEnv` implements it over `node:child_process` + `node:fs/promises`: POSIX spawns are `detached` into their own process group so `kill()` signals the whole tree (`process.kill(-pid, …)`, SIGTERM → 2 s grace → SIGKILL); Windows kills go through `taskkill /T /F /PID`. The spawned wrapper inherits the noninteractive knobs the one-shot bash tool path sets (`NO_COLOR`, `TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, `SHELL=<bash>`).

## API

- `buildResumingWrapperScript(options)` — the task-agnostic wrapper template (`{ snapshotDir, initialCwd }`, paths shell-quoted; phase 1 / frame read / phase 2 / epilogue). One script serves every task AND the standby.
- `new ResumingShell(env, { snapshotDir, initialCwd, shellPath? })` — per-agent stateful shell (fg mutex + commit-flag lifecycle + standby).
- `runTask({ id, command, cwd?, background })` → handle `{ stdin, stdout, stderr, wait(), kill(), detach() }`. fg tasks queue on the per-shell mutex and create the commit flag; bg tasks spawn immediately without one. A live standby is consumed (critical path ≈ 0); otherwise a wrapper is spawned on demand.
- `kill(id)` / `detach(id)` — remove the commit flag first (so the epilogue can never commit), then kill the process tree / free the fg slot. Never touch the idle standby.
- `dispose()` — shell teardown: kill every live task AND the idle standby (additive to the per-task kills the adapters already drive; a later `runTask` simply starts cold again).
- `LocalResumingShellEnv` — the local env implementation.

## Engine adapters

- **v1** (`packages/agent-core/src/tools/builtin/shell/stateful-shell.ts`) and **v2** (`packages/agent-core-v2/src/agent/tools/os/bash/`) adapt the contract onto their fs / process services — the v2 side shares the one-shot `ProcessTask` path (streaming, two-stage kill) and derives the snapshot dir (`<sessionDir>/agents/<agentId>/shell-state` locally; execution-side home on remote workspaces). Both engines also implement the fork-on-create seeding described above (v2 in `AgentLifecycleService` via `seedShellState.ts`, best-effort and warn-only; v1 in `Session.createAgent` via `seedShellStateSnapshot`). Both Bash tools pass an explicit `cwd` (the session workdir) for model-initiated calls, so the snapshot's restored cwd only steers user-initiated `!` commands; commits are unaffected — an agent's `cd` still persists for the user's shell.

## References

- `packages/kaos/src/stateful-shell/resuming.ts` — the wrapper template, `ResumingShell`, `ResumingShellEnv`, `LocalResumingShellEnv`; its header comment is the authoritative spec.
- `packages/kaos/src/stateful-shell/filterDetection.ts` + `scripts/gen-shell-state-filter.mts` — the dev-time bookkeeping-variable detection; emits `src/stateful-shell/shellStateFilter.generated.ts` (drift-checked by `test/shell-state-filter.test.ts`).
- `packages/kaos/test/resuming.test.ts` — script invariants, fake-env TS-side behavior (mutex, flags, the standby lifecycle: reuse/replace/keep/replenish/dead-fallback/dispose), real-bash commit/rollback/mutex/mtime/sweep semantics, the session-resume smoke, and a 3-command sequenced standby-reuse e2e.
- `packages/agent-core-v2/src/agent/tools/os/bash/` — the v2 adapter.
- `docs/workspace-backends.md` — how remote workspaces get the exec env the resuming shell rides on.
