# Shadow mode

Shadow mode lets an agent temporarily continue the conversation in another
environment — most commonly when a session bound to a remote (`ssh://`)
workspace needs access to the local machine. EnterShadowMode forks the
session into a shadow session rooted at the shadow target; ExitShadowMode
merges the shadow session's conversation rows back into the original session
and discards the shadow. The fork/switch/merge is designed to be fully
transparent to clients: the session keeps its original id throughout, and
each phase behaves like an ordinary session fork.

EnterShadowMode accepts an optional `path` argument selecting the shadow
target, mirroring workspace-creation semantics:

- omitted: the local kimi home (`~/.kimi-code`)
- an absolute local path (`~` is expanded): any directory on the local
  machine; the path is validated up front (must exist and be a directory)
- an `ssh://[user@]host[:port]/abs/path` spec: a directory on another remote
  host, gated by the `ssh-workdir` experimental flag
  (`KIMI_CODE_EXPERIMENTAL_SSH_WORKDIR`); the spec is canonicalized
  (default port elided, path posix-normalized) before the fork

Invalid targets (malformed ssh spec, flag disabled, relative or missing
local path) fail the tool call itself, before the turn ends — no pending
switch is armed.

## Expected behaviors

These are the behaviors covered by the unit suites
(`agent-core-v2/test/features/shadow/shadow.test.ts`,
`kap-server/test/services/transcript.test.ts`,
`kap-server/test/sessionEventBroadcaster.test.ts`) and by end-to-end testing
against the web UI.

### Entering shadow mode

- The switch happens at a turn boundary, never mid-turn.
- The shadow session is a full wire fork of the source, created under the
  target workspace with `shadow_of` / `shadow_fork_message_count` /
  `shadow_active` / `shadow_root` provenance metadata. The source session
  stays untouched as the checkpoint.
- A continuation prompt is enqueued so the conversation resumes autonomously
  in the shadow session.
- Clients keep addressing the original session id. Shadow activity streams
  into the same session view as ordinary session activity — steps, tool
  calls, and messages appear live, and the session's event journal continues
  without interruption.
- Users can keep sending messages while shadowed; they are routed to the
  active shadow session.
- A fresh page load while shadowed shows the shadow session's transcript:
  cold transcript reads follow the alias to the shadow session's files.

### While shadowed

- The shadow session is never client-visible: it is filtered from session
  listings, direct access by its id answers 404 on REST routes, and it cannot
  be live-resolved for transcript streaming.
- Lifecycle-structure actions on the checkpointed source are refused: fork,
  restore, archive, and child-session creation all fail until the exit.
- The frozen source session never resolves for prompts or messages.

### Exiting shadow mode

- The shadow main agent's post-fork context rows are appended to the source
  main agent, and the source turn clock is realigned by replaying the
  shadow's turn prompts. The source wire is flushed before the switch is
  published, so the merged rows are durable before any client re-baselines.
- A continuation prompt is enqueued on the source, the admission hold is
  released, and id routing returns to identity.
- The transcript view is rebuilt from the source wire across the switch:
  the shadow-phase steps remain visible after exit (the session continues
  exactly as an ordinary fork would), and steps produced after the exit
  stream in as usual.
- The switch event itself never reaches clients; the web UI learns the new
  baseline only through the transcript reset/ops it already understands.
- The shadow session is deleted, destroying every shadow-side tool state. If
  the enter cataloged the target workspace and the round trip leaves it
  empty, its workspace row is removed as well (keyed on the recorded
  `shadow_root`, so cleanup survives a server restart mid-shadow).

### Restart resilience

- The alias maps are rebuilt from the session index on server start, so a
  server restarted mid-shadow keeps hiding the shadow session and routing
  the source id to it.

### Subagents

- The shadow feature is assembled only for the main agent: subagents never
  see the EnterShadowMode / ExitShadowMode tools, report no shadow status,
  and have their enter/exit requests rejected.
- Subagents created inside shadow mode are ordinary subagents of the shadow
  session: they inherit its execution environment and run in the shadow
  workdir, exactly like the main agent does while shadowed.

## Known limitations

- The merge carries context messages only. Shadow-phase steps therefore
  render with message-level fidelity after exit; the shadow session's
  richer per-step wire records (step timing, task output tails) are
  discarded with the shadow session.
