Use this tool when you are done with local access and want to return to the session's original (e.g. remote ssh) workspace. It only works inside a shadow session (see EnterShadowMode).

Exiting shadow mode happens at the turn boundary:

- this shadow session's conversation rows since the fork are merged back into the original session, so nothing that happened locally is lost from the transcript,
- the original session — preserved untouched as the checkpoint — is resumed, restoring the original (e.g. remote) tool state,
- this shadow session is deleted: its local shell state and background tasks are destroyed.

Files you wrote under the shadow workdir persist on the local machine; everything else about the local environment is discarded.

The tool call ends your current turn immediately and runs without asking the user for approval in any permission mode. Do not call further tools after ExitShadowMode in the same turn.
