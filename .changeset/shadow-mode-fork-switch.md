---
"@moonshot-ai/kimi-code": minor
---

Add shadow mode for agents bound to remote (ssh://) workspaces: the model can call EnterShadowMode to continue the conversation in a local session rooted at ~/.kimi-code, and ExitShadowMode to merge the shadow rows back into the original session and restore the untouched remote state. The switch is invisible to clients — kap-server keeps serving the original session id throughout (shadow activity arrives as ordinary session activity, and the frozen remote session stays unreachable until exit). Shadow tools are main-agent only: subagents never see them. Available on kimi web; disable via KIMI_CODE_EXPERIMENTAL_SHADOW_MODE=false.
