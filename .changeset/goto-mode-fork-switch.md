---
"@moonshot-ai/kimi-code": minor
---

Add GOTO for agents bound to remote (ssh://) workspaces: the model can call GOTO to continue the conversation in a session rooted at another path, and GOBACK to merge the shadow session's rows back into the original session and restore the untouched remote state. The switch is invisible to clients — kap-server keeps serving the original session id throughout (shadow activity arrives as ordinary session activity, and the frozen remote session stays unreachable until going back). GOTO tools are main-agent only: subagents never see them. Available on kimi web; disable via KIMI_CODE_EXPERIMENTAL_GOTO_MODE=false.
