/**
 * Resuming-based stateful shell — one FRESH bash process per command whose
 * in-memory state (variables incl. unexported ones, functions incl. conda
 * activation, cwd, umask) is restored from and committed to a durable
 * snapshot in `<snapshotDir>/shell-state.{state,vars,funcs}`.
 *
 * This replaces the fork-based engine (`engine.ts` on the old branch): no
 * immortal "tip" process, no per-task forks, no outfile polling, no protocol
 * frames, no detach markers, no PING/PONG, no REAPED, no kill ladders. Each
 * task is a direct child of the execution environment, so stdout/stderr are
 * real pipes, the exit code comes from `wait()`, and kill is the ordinary
 * two-stage tree kill.
 *
 * The model:
 *
 *  - {@link buildResumingWrapperScript} emits the self-contained bash
 *    wrapper, in TWO PHASES. Phase 1 (the preamble) runs as soon as the
 *    process is spawned: history/prompt off, function definitions,
 *    `~/.bashrc` sourcing with the conda hook probe, the defensive initial
 *    cd, and the snapshot absorb with a `[bash state] replay failed
 *    (<detail>)` stderr notice on failure — then the wrapper BLOCKS on a
 *    single `read` of one frame line from stdin. Phase 2 runs at hand-off:
 *    decode the frame, the stale commit-flag sweep (fg only), the
 *    tool-requested `cd`, the pre-state capture (fg only), the EXIT trap,
 *    the base64-decoded user command `eval`'d with stdin at EOF, and the
 *    epilogue — a single EXIT trap that commits the snapshot (atomic
 *    tmp+rename, builtin string-compare skip for no-op commits) ONLY when
 *    the task is foreground AND its per-task commit flag
 *    (`<snapshotDir>/<taskId>.commit-ok`) exists AND the exit code is 0. A
 *    commit prints the `[bash state]` note (conda / exported-env NAMES
 *    only, never values — cwd changes are deliberately not reported) to
 *    stderr. A user command that replaces the shell
 *    (`exec`) or installs its own EXIT trap clobbers the epilogue — its
 *    state changes are discarded (rollback), the same degradation the old
 *    REAPED path covered.
 *  - Delivery: the script is task-AGNOSTIC (everything task-specific rides
 *    the frame), written once per spawn to
 *    `<snapshotDir>/wrappers/<taskId-or-standby>.sh` via `env.fs.writeText`
 *    and spawned as `bash <script>` (posix-converted on Windows). `bash -s`
 *    cannot work here: bash would buffer frame bytes from the same stdin it
 *    reads the program from. Stdin therefore carries exactly ONE frame
 *    line, then EOF for the command (interactive commands like `read` /
 *    `cat` get EOF immediately, matching the one-shot behavior). Frame
 *    format, tab-separated and LF-terminated:
 *
 *      `TASK_ID  \t  FG(0|1)  \t  CWD_BASE64|`-`  \t  COMMAND_BASE64`
 *
 *    (`-` marks an absent tool-requested cwd; base64 has no tabs/newlines,
 *    so the frame is unambiguous. Script files are removed best-effort once
 *    their process has exited — bash reads scripts incrementally, so a file
 *    must outlive its process.)
 *  - {@link ResumingShell} owns the per-shell machinery: the snapshot dir,
 *    the foreground mutex (fg tasks run strictly serialized so the next
 *    command sees the previous command's committed state; bg tasks run
 *    unserialized, restore read-only and never get a commit flag), the
 *    commit-flag lifecycle — created per fg task before the hand-off,
 *    removed by `kill(id)` / `detach(id)` BEFORE the process can
 *    exit-commit, removed by the wrapper's own trap on exit, and swept by
 *    the next fg wrapper when a crashed run left one behind (the env's fs
 *    has no listing primitive, so the sweep lives in the wrapper) — and the
 *    STANDBY: one idle pre-spawned wrapper blocked on the phase-1 frame
 *    read, so the next command's spawn + bashrc + conda probe + absorb all
 *    complete off the critical path.
 *  - Standby lifecycle and snapshot-version reasoning: a standby is only
 *    valid for the snapshot version it absorbed in phase 1. The ONLY writer
 *    of the durable snapshot is an fg task whose exit code is 0 and whose
 *    commit flag still exists, so validity is maintained by three rules:
 *      1. after every fg task that exits 0 (commit or no-op commit), kill
 *         any idle standby and spawn a fresh one — the fresh preamble
 *         absorbs the just-committed snapshot (the respawn happens in the
 *         background, off the critical path);
 *      2. after a non-zero fg exit (rollback — the durable snapshot is
 *         byte-untouched) the idle standby is still valid: keep it;
 *      3. a bg task never commits, so when it consumes the standby the
 *         replacement is spawned immediately at hand-off.
 *    A standby that died before use is discarded and `runTask` falls back
 *    to an on-demand cold spawn. `kill(id)` / `detach(id)` never touch the
 *    idle standby; {@link ResumingShell.dispose} kills every live task AND
 *    the standby (shell teardown).
 *  - {@link ResumingShellEnv} is the machine seam — spawn + a minimal fs +
 *    os/shell facts, one size slimmer than the old `StatefulShellHost` (no
 *    readRange / readdirNames / captureExec / signalProcess / pidAlive).
 *    {@link LocalResumingShellEnv} is the local node implementation
 *    (node:child_process + node:fs/promises; POSIX process-group kills via
 *    `detached` spawns + `process.kill(-pid, …)`, Windows via `taskkill /T
 *    /F`, SIGTERM → grace → SIGKILL escalation).
 *
 * Snapshot format (same three files as the old engine):
 *
 *  - `shell-state.state` — a re-sourcable dump: `cd <pwd>`, `umask <mask>`,
 *    every function, and `declare -p` per variable, in sorted order so an
 *    unchanged state compares byte-identical across dumps.
 *  - `shell-state.vars` / `shell-state.funcs` — sorted name lists used by
 *    the absorb to unset whatever a later dump no longer has.
 *
 * The absorb applies a dump with `declare -g` injected (sourced inside a
 * function it would otherwise create function-LOCAL variables that vanish on
 * return; function definitions, `cd`, and `umask` are shell-global already).
 * The unset-diff + source order no longer matters for durability: the dump
 * is the whole truth and every process starts from it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';

import { join } from 'pathe';

import { SHELL_STATE_BOOKKEEPING_ALTS } from './shellStateFilter.generated';

// ── Constants ─────────────────────────────────────────────────────────────

/** SIGTERM → SIGKILL escalation grace for the two-stage process-tree kill. */
const KILL_ESCALATION_MS = 2_000;

/** Subdirectory of the snapshot dir holding the per-spawn wrapper scripts. */
const WRAPPERS_DIR = 'wrappers';

const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGTERM: 143,
  SIGKILL: 137,
  SIGINT: 130,
};

// ── Shell-side wrapper script ─────────────────────────────────────────────

export interface ResumingWrapperScriptOptions {
  /** Snapshot dir as the WRAPPER sees it (posix-converted on Windows). */
  readonly snapshotDir: string;
  /** Initial cwd as the wrapper sees it (cold-start default). */
  readonly initialCwd: string;
}

/**
 * The wrapper script, written to a per-spawn file and spawned as
 * `bash <script>` — task-AGNOSTIC: everything task-specific (id, fg/bg,
 * tool cwd, command) arrives on the single stdin frame line the phase-1
 * `read` blocks on (see the module header for the frame format). That is
 * what makes the standby possible: one generic wrapper can be pre-spawned
 * long before its task exists. Once the frame line is consumed, stdin is
 * EOF for the command — interactive commands like `read` / `cat` get EOF
 * immediately, matching the one-shot behavior.
 *
 * Phase 1 (preamble) / phase 2 (hand-off) / epilogue per the resuming
 * design; the dump / absorb / state-note functions and the KEEPVARS filter
 * are extracted from the old fork engine's protocol script (its tip loop,
 * task frames, outfile machinery, detach markers, and PING/PONG are gone).
 */
export function buildResumingWrapperScript(options: ResumingWrapperScriptOptions): string {
  const snap = shellQuote(`${options.snapshotDir}/shell-state`);
  const snapDir = shellQuote(options.snapshotDir);
  const initialCwd = shellQuote(options.initialCwd);
  return `unset PROMPT_COMMAND
# Dummy prompts so \`[ -z "$PS1" ] && return\` guards in ~/.bashrc still let
# its content through; cleared again right after sourcing.
PS1='$ '
PS2='> '
set +o history
__KIMI_SNAP=${snap}
__KIMI_SNAPDIR=${snapDir}
__KIMI_INITIAL_CWD=${initialCwd}
# Variables that must never be dumped or unset during absorb: bash's
# bookkeeping variables — detected dev-time from a live bash by
# scripts/gen-shell-state-filter.mts (readonly by declare flag, volatile by
# double capture, lazy/function-context by a probe function; committed as
# ./shellStateFilter.generated.ts and drift-checked by
# test/shell-state-filter.test.ts) — plus every __kimi_* / __KIMI_* protocol
# variable, the only hand-maintained part.
__KIMI_KEEPVARS_RE='^(${SHELL_STATE_BOOKKEEPING_ALTS}|__kimi_.*|__KIMI_.*)$'

__kimi_dump_state() {
  local __kimi_v __kimi_fline
  {
    printf 'cd %q\\n' "$PWD"
    printf 'umask %s\\n' "$(umask)"
    declare -f
    # Sorted iteration: declare -p lines must come out in a stable order so
    # an unchanged state compares byte-identical across dumps (the epilogue
    # persists the durable copy only on real changes).
    while read -r __kimi_v; do
      [[ "$__kimi_v" =~ $__KIMI_KEEPVARS_RE ]] && continue
      declare -p "$__kimi_v" 2>/dev/null
    done < <(compgen -A variable | sort)
  } > "$__KIMI_SNAP.state.tmp" 2>/dev/null
  # The name lists are sorted so an unchanged state compares byte-identical
  # across dumps (the epilogue persists the durable copy only on real
  # changes). The keep-regex filter is a builtin loop, not a grep spawn.
  while read -r __kimi_v; do
    [[ "$__kimi_v" =~ $__KIMI_KEEPVARS_RE ]] && continue
    printf '%s\\n' "$__kimi_v"
  done < <(compgen -A variable | sort) > "$__KIMI_SNAP.vars.tmp"
  # \`declare -F\` lines are \`declare -f NAME\` / \`declare -fx NAME\`; the name
  # is everything after the last space. Sorted after stripping so the list
  # is name-sorted (a raw-line sort would put exported \`declare -fx\`
  # entries after their non-exported siblings).
  while read -r __kimi_fline; do
    printf '%s\\n' "\${__kimi_fline##* }"
  done < <(declare -F) | sort > "$__KIMI_SNAP.funcs.tmp"
}

# Absorb a state dump at base $1: unset variables/functions the dump no
# longer has (guarded by the keep-regex and the dump's name lists), then
# source the state file. The dump's declare lines get -g injected: sourced
# inside this function they would otherwise create function-LOCAL variables
# that vanish on return (function definitions, cd, and umask are
# shell-global already and need no help).
# Name-list membership is checked with builtin regexes instead of one grep
# spawn per name (the old engine's approach): the absorb runs on EVERY task
# — fg and bg — and external spawns are expensive on Windows Git Bash
# (~0.2 s each, ~20 s per absorb). Variable names are always shell
# identifiers, so they embed in the alternation as-is; function names are
# escaped per line so unusual-but-legal names stay exact-match.
__kimi_absorb() {
  local __kimi_v __kimi_fline __kimi_fn __kimi_vars_re __kimi_fns_re
  if [[ -f "$1.vars" ]]; then
    __kimi_vars_re="^($(<"$1.vars"))$"
    __kimi_vars_re="\${__kimi_vars_re//$'\\n'/|}"
    while read -r __kimi_v; do
      [[ "$__kimi_v" =~ $__KIMI_KEEPVARS_RE ]] && continue
      [[ "$__kimi_v" =~ $__kimi_vars_re ]] || unset "$__kimi_v" 2>/dev/null
    done < <(compgen -A variable)
  fi
  if [[ -f "$1.funcs" ]]; then
    __kimi_fns_re='^('
    while IFS= read -r __kimi_fn; do
      __kimi_fns_re+="\${__kimi_fn//[^A-Za-z0-9_]/\\\\&}|"
    done < "$1.funcs"
    __kimi_fns_re+=')$'
    while read -r __kimi_fline; do
      __kimi_fn="\${__kimi_fline##* }"
      [[ "$__kimi_fn" == __kimi_* ]] && continue
      [[ "$__kimi_fn" =~ $__kimi_fns_re ]] || unset -f "$__kimi_fn" 2>/dev/null
    done < <(declare -F)
  fi
  source <(sed 's/^declare /declare -g /' "$1.state")
}

# Diff what THIS task changed (its start env was captured post-cd, so a
# tool-requested cwd stays silent) and print a single-line note made of
# parts joined by '; ': conda=<env> / conda=none when CONDA_DEFAULT_ENV
# changed; env: +ADDED, ~CHANGED, -REMOVED for other exported variables —
# NAMES only, never values, which may hold secrets and must never land in a
# transcript. cwd changes are deliberately NOT reported: the note lands in
# chat history, where a moving cwd confuses agents, and a user can always
# pwd. PWD/OLDPWD are filtered out of the env diff for the same reason —
# they are cwd bookkeeping, not signal. Unexported variables, functions, and
# umask stay silent (they change too often to be signal), and a conda env
# change filters the conda-internal variables plus the PATH rewrite out of
# the env diff — they are the activation's mechanics, not signal.
# The diff is pure builtin (the old comm/sed/grep pipeline spawned ~6-10
# external processes): both sides are parsed into associative arrays by name
# with parameter-expansion prefix stripping, and the name sets are diffed
# with array membership plus raw-tail comparisons.
# $1 = sorted 'export -p' output at task start (already PWD/OLDPWD-filtered).
__kimi_state_note() {
  local note='' changes='' entry name oldconda='' newconda conda_filter=''
  local __kimi_s __kimi_c __kimi_start_names=()
  declare -A __kimi_start __kimi_cur
  # Parse the start capture into an assoc array keyed by name, keeping the
  # raw \`NAME=value\` tail (the \`declare -x \` / \`declare -ax \` prefix and
  # flag letters stripped) so a later byte comparison detects value changes
  # exactly like the old comm-based diff did. The name array's order mirrors
  # $1's sorted line order, which the removed pass reuses for sorted output.
  if [[ -n "$1" ]]; then
    while IFS= read -r __kimi_s; do
      [[ -z "$__kimi_s" ]] && continue
      __kimi_s=\${__kimi_s#declare -}
      __kimi_s=\${__kimi_s#* }
      name=\${__kimi_s%%=*}
      if [[ "$__kimi_s" == CONDA_DEFAULT_ENV=* ]]; then
        oldconda=\${__kimi_s#CONDA_DEFAULT_ENV=}
        oldconda=\${oldconda#\\"}
        oldconda=\${oldconda%\\"}
      fi
      [[ "$name" == PWD || "$name" == OLDPWD ]] && continue
      __kimi_start[$name]=$__kimi_s
      __kimi_start_names+=("$name")
    done <<< "$1"
  fi
  # Same parse for the current \`export -p\` output.
  while IFS= read -r __kimi_c; do
    [[ -z "$__kimi_c" ]] && continue
    __kimi_c=\${__kimi_c#declare -}
    __kimi_c=\${__kimi_c#* }
    name=\${__kimi_c%%=*}
    [[ "$name" == PWD || "$name" == OLDPWD ]] && continue
    __kimi_cur[$name]=$__kimi_c
  done <<< "$(export -p)"
  newconda="\${CONDA_DEFAULT_ENV:-}"
  if [[ "$newconda" != "$oldconda" ]]; then
    note="\${note:+$note; }conda=\${newconda:-none}"
    conda_filter='^(CONDA_DEFAULT_ENV|CONDA_PREFIX.*|CONDA_PROMPT_MODIFIER|CONDA_SHLVL|CONDA_EXE|CONDA_PYTHON_EXE|_CE_CONDA|_CE_M|__CONDA_.*|SSL_CERT_FILE|SSL_CERT_DIR|PATH)$'
  fi
  # Added/changed entries in sorted order: compgen lists exported names
  # sorted, exactly like the comm output did. A name present in both sides
  # with a different value is \`~name\`, one only in the current side is
  # \`+name\`.
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    [[ "$name" == PWD || "$name" == OLDPWD ]] && continue
    [[ -n "$conda_filter" && "$name" =~ $conda_filter ]] && continue
    [[ -n "\${__kimi_cur[$name]+x}" ]] || continue
    if [[ -n "\${__kimi_start[$name]+x}" ]]; then
      [[ "\${__kimi_start[$name]}" == "\${__kimi_cur[$name]}" ]] && continue
      entry="~$name"
    else
      entry="+$name"
    fi
    changes="\${changes:+$changes, }$entry"
  done < <(compgen -A export)
  # Removed entries (present at start, gone or unexported now), in the start
  # capture's sorted order.
  for name in "\${__kimi_start_names[@]}"; do
    [[ -n "\${__kimi_cur[$name]+x}" ]] && continue
    [[ -n "$conda_filter" && "$name" =~ $conda_filter ]] && continue
    changes="\${changes:+$changes, }-$name"
  done
  [[ -n "$changes" ]] && note="\${note:+$note; }env: $changes"
  printf '%s' "$note"
}

__kimi_task_exit() {
  # Every local in this function is __kimi_-prefixed: the frame is still on
  # the stack when __kimi_dump_state runs, so an unprefixed local would leak
  # into the dump (and later be restored as a global). KEEPVARS filters the
  # prefix out.
  trap - EXIT
  local __kimi_ec="$1"
  # Commit gate: foreground AND the per-task commit flag exists AND exit 0.
  # detach/kill remove the flag while the process runs, so the epilogue can
  # never commit state the harness no longer wants; a non-zero exit rolls
  # back (the durable snapshot is untouched). exec / SIGKILL / a clobbered
  # EXIT trap skip the epilogue entirely — the same rollback.
  if [[ "$__KIMI_FG" == "1" && -f "$__KIMI_SNAPDIR/$__KIMI_TASK_ID.commit-ok" && "$__kimi_ec" -eq 0 ]]; then
    local __kimi_note
    __kimi_note="$(__kimi_state_note "$__KIMI_START_ENV")"
    __kimi_dump_state
    local __kimi_f
    for __kimi_f in state vars funcs; do
      # Zero-write no-op commits: an unchanged dump does not touch the
      # durable copy (atomic tmp+rename). Builtin string compare instead of
      # the old external \`cmp\` spawn — one less spawn per file on the hot
      # path: \`$(<…)\` strips trailing newlines on BOTH sides and dump
      # content can never contain NUL bytes (bash variables can't hold
      # them), so the comparison is exact for this data. A skipped .tmp file
      # is left behind — the next dump's \`>\` truncates it (a rename
      # consumes it), so the old \`rm -f\` spawns are gone too.
      [[ -f "$__KIMI_SNAP.$__kimi_f" && "$(<"$__KIMI_SNAP.$__kimi_f.tmp")" == "$(<"$__KIMI_SNAP.$__kimi_f")" ]] || mv -f "$__KIMI_SNAP.$__kimi_f.tmp" "$__KIMI_SNAP.$__kimi_f"
    done
    [[ -n "$__kimi_note" ]] && printf '[bash state] %s\\n' "\${__kimi_note//$'\\n'/ }" >&2
  fi
  # The commit gate never outlives the process.
  rm -f "$__KIMI_SNAPDIR/$__KIMI_TASK_ID.commit-ok"
  exit "$__kimi_ec"
}

# Source the user's bashrc so conda init blocks work (with the dummy prompts
# still set, the interactive-only guards in ~/.bashrc let their content
# through).
[[ -f ~/.bashrc ]] && source ~/.bashrc
PS1=''
PS2=''
# Conda init blocks commonly sit behind interactive-only guards
# (\`case $- in *i*\`) in ~/.bashrc, which non-interactive sourcing never
# reaches. Probe the standard hook locations when \`conda\` is still not
# defined as a function.
declare -F conda >/dev/null 2>&1 || for __kimi_conda_hook in "$HOME/anaconda3/etc/profile.d/conda.sh" "$HOME/miniconda3/etc/profile.d/conda.sh" /opt/conda/etc/profile.d/conda.sh; do
  [[ -f "$__kimi_conda_hook" ]] && . "$__kimi_conda_hook" && break
done
unset __kimi_conda_hook

# Defensive initial cd — the process was spawned at this cwd already; the
# wrapper stays self-contained for hosts whose spawn may not honor cwd.
cd "$__KIMI_INITIAL_CWD" 2>/dev/null || :

# Restore the committed snapshot (session resume / server restart). AFTER
# bashrc + conda init, so the committed state — post-activation conda vars,
# the conda function, PATH, cwd — wins wholesale (no re-activation needed:
# the dump IS the post-activation state). A replay failure (non-zero exit or
# any stderr, e.g. a stale cd target) is reported on stderr and the shell
# continues cold at the initial cwd. The capture file is per-PROCESS (\`$$\`)
# because the task id only arrives with the frame; its first line is read
# with a builtin (the old \`head -n 1\` was one more external spawn), and the
# \`rm -f\` stays — the file would otherwise accumulate per process.
if [[ -f "$__KIMI_SNAP.state" ]]; then
  __kimi_absorb "$__KIMI_SNAP" 2>"$__KIMI_SNAPDIR/.restore-err.$$"
  __kimi_restore_rc=$?
  __kimi_restore_err=''
  IFS= read -r __kimi_restore_err < "$__KIMI_SNAPDIR/.restore-err.$$" || :
  rm -f "$__KIMI_SNAPDIR/.restore-err.$$"
  if [[ "$__kimi_restore_rc" -ne 0 || -n "$__kimi_restore_err" ]]; then
    printf '[bash state] replay failed (%s)\\n' "\${__kimi_restore_err:-unknown error}" >&2
  fi
  unset __kimi_restore_rc __kimi_restore_err
fi

# ══ Phase 1 ends here. The wrapper now blocks on the ONE task frame the
# harness writes to stdin at hand-off (a standby idles at this read — its
# whole preamble is already paid). EOF instead of a line means the harness
# went away: exit quietly (no trap is installed yet, nothing to commit).
IFS=$'\\t' read -r __KIMI_TASK_ID __KIMI_FG __KIMI_CWDB64 __KIMI_CMDB64 || exit 0

# '-' marks an absent tool-requested cwd (the command then runs at the cwd
# restored from the snapshot); decoded only when present.
__KIMI_TOOL_CWD=''
if [[ "$__KIMI_CWDB64" != '-' ]]; then
  __KIMI_TOOL_CWD="$(printf '%s' "$__KIMI_CWDB64" | base64 -d)"
fi

# Sweep stale commit flags from crashed runs (abnormal exits — SIGKILL,
# harness crash — leave the flag behind; the next foreground wrapper removes
# it). Background wrappers never touch flags: a concurrent fg task may
# legitimately own one, and a bg task never commits anyway.
if [[ "$__KIMI_FG" == "1" ]]; then
  for __kimi_flag in "$__KIMI_SNAPDIR"/*.commit-ok; do
    [[ -e "$__kimi_flag" ]] || continue
    [[ "\${__kimi_flag##*/}" == "$__KIMI_TASK_ID.commit-ok" ]] && continue
    rm -f "$__kimi_flag"
  done
fi

# A tool-requested cwd overrides the restored one; a stale target aborts the
# task (rollback — the EXIT trap sees the non-zero status). The abort exits
# before the trap is installed, so the commit flag lingers for the next fg
# wrapper's stale sweep.
if [[ -n "$__KIMI_TOOL_CWD" ]]; then
  cd "$__KIMI_TOOL_CWD" || exit 1
fi

# Baseline for the commit-time state note: captured AFTER the tool cd.
# PWD/OLDPWD are filtered here and in __kimi_state_note — cwd bookkeeping,
# not signal. Background tasks never commit, so they skip the capture
# entirely.
if [[ "$__KIMI_FG" == "1" ]]; then
  __KIMI_START_ENV="$(export -p | while IFS= read -r __kimi_e; do
    [[ "$__kimi_e" == 'declare -x PWD='* || "$__kimi_e" == 'declare -x PWD '* || "$__kimi_e" == 'declare -x OLDPWD='* || "$__kimi_e" == 'declare -x OLDPWD '* ]] && continue
    printf '%s\\n' "$__kimi_e"
  done | sort)"
fi

trap '__kimi_task_exit "$?"' EXIT

# The user command, base64-carried by the frame and eval'd at top level.
# stdin is already at EOF (the frame line was the whole input).
eval "$(printf '%s' "$__KIMI_CMDB64" | base64 -d)"
`;
}

// ── Types ────────────────────────────────────────────────────────────────

/** A process spawned on the shell's execution environment. */
export interface ResumingProc {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;
  readonly exitCode: number | null;
  wait(): Promise<number>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

/** Minimal fs surface the resuming shell needs (no listing primitive). */
export interface ResumingShellFs {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  /** Recursive, exist-ok. */
  mkdir(path: string): Promise<void>;
  /** Best-effort delete (missing files are fine). */
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface ResumingShellFacts {
  /** The POSIX shell to spawn. */
  readonly shell: 'bash';
  /** Windows → Git Bash: posix-convert embedded paths, taskkill kills. */
  readonly windows: boolean;
}

export interface ResumingShellSpawnOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

/**
 * The machine seam: everything about the host the wrapper runs on that the
 * resuming core must not hard-code. Local = {@link LocalResumingShellEnv};
 * a remote implementation (the RTS pipe of the ssh-workdir plan) has the
 * same shape.
 */
export interface ResumingShellEnv {
  spawn(
    args: readonly string[],
    options?: ResumingShellSpawnOptions,
  ): Promise<ResumingProc>;
  readonly fs: ResumingShellFs;
  readonly facts: ResumingShellFacts;
}

export interface ResumingShellOptions {
  /** Directory holding the durable snapshot and the per-task commit flags. */
  readonly snapshotDir: string;
  /** Initial working directory (cold-start cwd; the process is spawned there). */
  readonly initialCwd: string;
  /** Path of the bash binary; defaults to `env.facts.shell`. */
  readonly shellPath?: string;
}

export interface ResumingShellRunInput {
  /** Unique task id — names the commit flag and the wrapper script file. */
  readonly id: string;
  readonly command: string;
  /** Tool-requested cwd (native path); overrides the restored snapshot cwd. */
  readonly cwd?: string;
  /** Background tasks restore read-only and never commit their changes. */
  readonly background: boolean;
}

/** Task handle: the wrapper process plus the shell-level kill/detach. */
export interface ResumingShellProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;
  readonly exitCode: number | null;
  wait(): Promise<number>;
  kill(): Promise<void>;
  detach(): Promise<void>;
}

/**
 * The idle pre-spawned wrapper: a generic wrapper process blocked on the
 * phase-1 frame read, its preamble (spawn + bashrc + conda probe + absorb)
 * already paid off the critical path. It belongs to no task and has no
 * commit flag. Valid only for the snapshot version it absorbed — see the
 * module header for the invalidation rules.
 */
interface StandbyWrapper {
  /** Native path of this standby's script file (removed on discard). */
  readonly scriptPath: string;
  /**
   * Resolves once the spawn completes (the preamble may still be running —
   * a frame written to its stdin simply waits in the pipe).
   */
  readonly proc: Promise<ResumingProc>;
  /** Set when the shell discards this standby (superseded / dispose). */
  discarded: boolean;
}

// ── ResumingShell ─────────────────────────────────────────────────────────

/**
 * One stateful shell (per agent). Owns the snapshot dir, the foreground
 * mutex, the commit-flag lifecycle, and the standby wrapper; every task is
 * a fresh wrapper process spawned through the env (or handed the pre-warmed
 * standby).
 */
export class ResumingShell {
  private readonly snapshotDir: string;
  private readonly initialCwd: string;
  private readonly shellPath: string;
  private readonly windows: boolean;
  /** Tail of the foreground queue: fg tasks run strictly serialized. */
  private fgQueue: Promise<void> = Promise.resolve();
  /** Live tasks by id, so `kill(id)` / `detach(id)` can reach the process. */
  private readonly tasks = new Map<string, ResumingShellTask>();
  /** Foreground-slot releases by task id (resolved on exit or detach). */
  private readonly fgReleases = new Map<string, () => void>();
  /** The one idle standby (see the module header for the lifecycle rules). */
  private standby: StandbyWrapper | null = null;
  private standbySeq = 0;

  constructor(
    private readonly env: ResumingShellEnv,
    options: ResumingShellOptions,
  ) {
    this.snapshotDir = options.snapshotDir;
    this.initialCwd = options.initialCwd;
    this.shellPath = options.shellPath ?? env.facts.shell;
    this.windows = env.facts.windows;
  }

  /**
   * Run one command in a fresh wrapper process. Foreground tasks queue
   * behind each other (the next command must see the previous command's
   * committed state); background tasks spawn immediately, absorb the
   * snapshot read-only, and never commit. When a live standby exists the
   * task is handed to it (commit flag first for fg, then the ONE stdin
   * frame — critical path ≈ 0); otherwise a wrapper is spawned on demand
   * (cold path: write the script, spawn, write the frame immediately).
   * Stale commit flags from crashed runs are swept by the wrapper.
   */
  async runTask(input: ResumingShellRunInput): Promise<ResumingShellProcess> {
    if (/[\t\r\n]/.test(input.id)) {
      throw new Error(
        `ResumingShell.runTask: task id must not contain tab/newline: ${JSON.stringify(input.id)}`,
      );
    }
    const foreground = !input.background;
    let fgRelease: (() => void) | undefined;
    if (foreground) fgRelease = await this.takeFgSlot();
    let scriptPath: string | undefined;
    try {
      await this.env.fs.mkdir(this.snapshotDir);
      if (foreground) {
        // The commit flag is created BEFORE the hand-off so the wrapper's
        // epilogue can never run without it (with a standby, "spawn" already
        // happened — the flag only has to precede the frame).
        await this.env.fs.writeText(this.flagPath(input.id), '');
      }
      const frame = buildTaskFrame({
        id: input.id,
        foreground,
        command: input.command,
        cwd: input.cwd === undefined ? undefined : this.toShellPath(input.cwd),
      });
      let proc: ResumingProc | undefined;
      // Defaults to this task's cold-path script; a consumed standby
      // overrides it (the file's cleanup then follows the task's settle).
      scriptPath = this.wrapperScriptPath(input.id);
      const standby = this.standby;
      this.standby = null;
      if (standby !== null) {
        if (!foreground) {
          // A bg task never commits, so the snapshot the next standby must
          // absorb cannot move: replenish right at hand-off.
          this.replaceStandby();
        }
        const warmed = await standby.proc.catch(() => undefined);
        if (warmed !== undefined && warmed.exitCode === null && !standby.discarded) {
          proc = warmed;
          scriptPath = standby.scriptPath;
        } else {
          // Dead or failed standby (killed mid-preamble, spawn error):
          // discard it and fall back to the on-demand cold path.
          this.discardStandby(standby);
        }
      }
      if (proc === undefined) {
        await this.writeWrapperScript(scriptPath);
        proc = await this.spawnWrapper(scriptPath);
      }
      try {
        proc.stdin.write(frame);
      } catch {
        /* the process may already be gone; wait() reports its exit */
      }
      try {
        proc.stdin.end();
      } catch {
        /* same */
      }
      const handle = new ResumingShellTask(this, input.id, proc);
      this.tasks.set(input.id, handle);
      if (foreground && fgRelease !== undefined) {
        this.fgReleases.set(input.id, fgRelease);
      }
      const settledScriptPath = scriptPath;
      void proc.wait().then(
        (code) => this.settleTask(input.id, foreground, code, settledScriptPath, fgRelease),
        () => this.settleTask(input.id, foreground, -1, settledScriptPath, fgRelease),
      );
      return handle;
    } catch (error) {
      if (foreground) {
        if (fgRelease !== undefined) fgRelease();
        this.fgReleases.delete(input.id);
        await this.env.fs.remove(this.flagPath(input.id)).catch(() => {});
      }
      if (scriptPath !== undefined) {
        await this.env.fs.remove(scriptPath).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Stop a task: remove its commit flag FIRST (so its EXIT trap can never
   * commit — the flag is the whole point; bash dies to SIGTERM without
   * running the trap anyway), then kill the process tree through the env.
   * Never touches the idle standby.
   */
  async kill(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (task === undefined) return;
    await this.env.fs.remove(this.flagPath(id)).catch(() => {});
    await task.proc.kill();
  }

  /**
   * Downgrade a foreground task to background semantics (harness timeout /
   * ctrl+b): the commit flag is removed BEFORE the process can exit-commit,
   * and the foreground slot is freed immediately so the next fg task can
   * start while the detached task keeps running in the background.
   * Never touches the idle standby.
   */
  async detach(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (task === undefined) return;
    await this.env.fs.remove(this.flagPath(id)).catch(() => {});
    const release = this.fgReleases.get(id);
    if (release !== undefined) {
      this.fgReleases.delete(id);
      release();
    }
  }

  /**
   * Shell teardown: kill every live task (each through the commit-flag
   * lifecycle) AND the idle standby. Additive to the per-task `kill(id)`
   * the adapters already drive; a later `runTask` simply starts cold again
   * (no disposed latch — the v2 closeShell→flip-on path reuses the shell).
   */
  async dispose(): Promise<void> {
    const standby = this.standby;
    this.standby = null;
    if (standby !== null) this.discardStandby(standby);
    await Promise.all(
      [...this.tasks.values()].map((task) => this.kill(task.id).catch(() => {})),
    );
  }

  private async takeFgSlot(): Promise<() => void> {
    const previous = this.fgQueue;
    let release!: () => void;
    this.fgQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  /**
   * Task exit hook: drop the task, remove its script file (bash reads
   * scripts incrementally, so the file must outlive the process), and for
   * foreground tasks apply the standby rules before freeing the slot:
   * exit 0 (commit or no-op commit — the durable snapshot may have moved)
   * → replace any idle standby with a fresh one; non-zero (rollback — the
   * snapshot is byte-untouched) → the idle standby stays valid, keep it.
   */
  private settleTask(
    id: string,
    foreground: boolean,
    exitCode: number,
    scriptPath: string,
    fgRelease: (() => void) | undefined,
  ): void {
    this.tasks.delete(id);
    void this.env.fs.remove(scriptPath).catch(() => {});
    if (!foreground || fgRelease === undefined) return;
    this.fgReleases.delete(id);
    if (exitCode === 0) {
      // Assigned synchronously BEFORE the slot is freed, so the next fg
      // task's runTask always sees the fresh standby (its preamble then
      // completes off the critical path).
      this.replaceStandby();
    }
    fgRelease();
  }

  /**
   * Kill any idle standby and spawn a fresh one (it must absorb the latest
   * committed snapshot). The respawn's script write + spawn + preamble all
   * happen in the background, off the critical path.
   */
  private replaceStandby(): void {
    const old = this.standby;
    this.standby = this.spawnStandby();
    if (old !== null) this.discardStandby(old);
  }

  /** Kick off a standby: write the generic script, then spawn it. */
  private spawnStandby(): StandbyWrapper {
    this.standbySeq += 1;
    const scriptPath = this.wrapperScriptPath(`standby-${this.standbySeq}`);
    const proc = (async (): Promise<ResumingProc> => {
      await this.writeWrapperScript(scriptPath);
      return this.spawnWrapper(scriptPath);
    })();
    // The standby is a best-effort optimization: a write/spawn failure must
    // never surface as an unhandled rejection — a consumer awaiting the
    // promise still sees the rejection and falls back to the cold path.
    proc.catch(() => {});
    return { scriptPath, proc, discarded: false };
  }

  /**
   * Discard a standby: kill its process (best-effort; it may still be
   * spawning) and remove its script file once nothing can read it.
   */
  private discardStandby(standby: StandbyWrapper): void {
    standby.discarded = true;
    const scriptPath = standby.scriptPath;
    void standby.proc
      .then(
        async (proc) => {
          await proc.kill().catch(() => {});
          await proc.wait().catch(() => {});
        },
        () => {},
      )
      .then(() => this.env.fs.remove(scriptPath))
      .catch(() => {});
  }

  /**
   * Spawn a wrapper at the session workdir; when the workdir has vanished
   * the spawn dies with a raw ENOENT before bash even starts — retry with an
   * inherited cwd instead, so the wrapper's own `cd` reports the missing
   * directory against the real path.
   */
  private async spawnWrapper(scriptPath: string): Promise<ResumingProc> {
    const argv = [this.shellPath, this.toShellPath(scriptPath)];
    try {
      return await this.env.spawn(argv, { cwd: this.initialCwd });
    } catch (error) {
      if (!(await this.env.fs.exists(this.initialCwd).catch(() => false))) {
        return this.env.spawn(argv, { cwd: undefined });
      }
      throw error;
    }
  }

  private wrapperScriptPath(name: string): string {
    return join(this.snapshotDir, WRAPPERS_DIR, `${name}.sh`);
  }

  /** The script is task-agnostic, so every spawn of this shell reuses it. */
  private async writeWrapperScript(scriptPath: string): Promise<void> {
    await this.env.fs.mkdir(join(this.snapshotDir, WRAPPERS_DIR));
    await this.env.fs.writeText(
      scriptPath,
      buildResumingWrapperScript({
        snapshotDir: this.toShellPath(this.snapshotDir),
        initialCwd: this.toShellPath(this.initialCwd),
      }),
    );
  }

  private flagPath(id: string): string {
    return join(this.snapshotDir, `${id}.commit-ok`);
  }

  private toShellPath(path: string): string {
    return this.windows ? windowsPathToPosixPath(path) : path;
  }
}

class ResumingShellTask implements ResumingShellProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  constructor(
    private readonly shell: ResumingShell,
    readonly id: string,
    readonly proc: ResumingProc,
  ) {
    this.stdin = proc.stdin;
    this.stdout = proc.stdout;
    this.stderr = proc.stderr;
  }

  get pid(): number {
    return this.proc.pid;
  }

  get exitCode(): number | null {
    return this.proc.exitCode;
  }

  wait(): Promise<number> {
    return this.proc.wait();
  }

  kill(): Promise<void> {
    return this.shell.kill(this.id);
  }

  detach(): Promise<void> {
    return this.shell.detach(this.id);
  }
}

// ── Local environment (node:child_process + node:fs/promises) ────────────

/**
 * The local implementation of the seam. Spawns each wrapper as a direct
 * child; POSIX spawns are detached into their own process group so kills
 * signal the whole tree (`process.kill(-pid, …)`), Windows kills go through
 * `taskkill /T /F` — the same pattern the one-shot process paths use.
 */
export class LocalResumingShellEnv implements ResumingShellEnv {
  readonly facts: ResumingShellFacts = {
    shell: 'bash',
    windows: process.platform === 'win32',
  };

  readonly fs: ResumingShellFs = {
    readText: (path) => readFile(path, 'utf8'),
    writeText: (path, text) => writeFile(path, text),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    remove: (path) => rm(path, { force: true }),
    exists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
  };

  async spawn(
    args: readonly string[],
    options?: ResumingShellSpawnOptions,
  ): Promise<ResumingProc> {
    const command = args[0];
    if (command === undefined) {
      throw new Error('LocalResumingShellEnv.spawn: empty argv');
    }
    const child = spawn(command, args.slice(1), {
      cwd: options?.cwd,
      env: {
        ...(process.env as Record<string, string>),
        // Same noninteractive knobs as the one-shot bash tool path.
        NO_COLOR: '1',
        TERM: 'dumb',
        GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
        SHELL: command,
        ...options?.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX: a fresh process group per wrapper so kill() can signal the
      // whole tree via process.kill(-pid, …). Windows has no process
      // groups; taskkill /T handles the tree instead.
      detached: !this.facts.windows,
      windowsHide: true,
    });
    await waitForSpawn(child);
    return new LocalResumingProc(child, this.facts.windows);
  }
}

class LocalResumingProc implements ResumingProc {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private _exitCode: number | null = null;
  private readonly completion: Promise<number>;
  private killRequested = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly windows: boolean,
  ) {
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error('LocalResumingShellEnv: process must be created with stdio pipes');
    }
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.pid = child.pid ?? -1;
    this.completion = new Promise<number>((resolveCompletion, rejectCompletion) => {
      child.on('exit', (code, signal) => {
        const exitCode =
          code ?? (signal === null ? undefined : SIGNAL_EXIT_CODES[signal]) ?? 143;
        this._exitCode = exitCode;
        resolveCompletion(exitCode);
      });
      child.on('error', (error) => {
        rejectCompletion(error);
      });
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  wait(): Promise<number> {
    return this.completion;
  }

  async kill(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (this.killRequested || this._exitCode !== null) return;
    this.killRequested = true;
    if (this.windows) {
      // Windows: no POSIX signals; taskkill /T /F force-terminates the tree.
      await taskkillTree(this.pid);
      return;
    }
    await signalGroup(this.child, this.pid, signal);
    if (signal === 'SIGTERM') {
      // Two-stage kill: SIGTERM → grace → SIGKILL, group-wide.
      const timer = setTimeout(() => {
        if (this._exitCode !== null) return;
        void signalGroup(this.child, this.pid, 'SIGKILL');
      }, KILL_ESCALATION_MS);
      timer.unref?.();
    }
  }
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolveSpawn();
    };
    const onError = (error: Error): void => {
      child.off('spawn', onSpawn);
      rejectSpawn(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** Group-signal a detached child; errors swallowed (kill is best-effort). */
async function signalGroup(
  child: ChildProcess,
  pid: number,
  signal: NodeJS.Signals,
): Promise<void> {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ESRCH') return; // already gone
    if (err.code === 'EPERM') {
      // Not our process group (shouldn't happen with detached spawns); fall
      // back to signaling the child directly.
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
    // Everything else is swallowed too: kill must never throw at the caller.
  }
}

/** taskkill /T /F — the Windows process-tree kill (hostProcessService pattern). */
function taskkillTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const done = (): void => resolve();
    killer.once('error', done);
    killer.once('close', done);
  });
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * The ONE stdin frame line a task is handed off with:
 * `TASK_ID \t FG(0|1) \t CWD_BASE64|- \t COMMAND_BASE64` + '\n'.
 * `cwd` here is already wrapper-converted (posix on Windows); `-` = absent.
 * The id must not contain tab/newline (checked by `runTask`); the base64
 * fields can't, so the tab-separated line is unambiguous.
 */
function buildTaskFrame(input: {
  readonly id: string;
  readonly foreground: boolean;
  readonly command: string;
  readonly cwd?: string;
}): string {
  const cwdField = input.cwd === undefined ? '-' : b64(input.cwd);
  return `${input.id}\t${input.foreground ? '1' : '0'}\t${cwdField}\t${b64(input.command)}\n`;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** Same conversion as the one-shot bash tool paths (kept local to avoid an
 *  import cycle). */
function windowsPathToPosixPath(path: string): string {
  if (path.startsWith('\\\\')) {
    return path.replaceAll('\\', '/');
  }

  const driveMatch = /^([A-Za-z]):(?:[\\/]|$)/.exec(path);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!.toLowerCase();
    const rest = path.slice(2).replaceAll('\\', '/');
    return `/${drive}${rest.startsWith('/') ? rest : `/${rest}`}`;
  }

  return path.replaceAll('\\', '/');
}
