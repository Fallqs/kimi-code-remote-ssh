---
"@moonshot-ai/kimi-code": patch
---

Closing or archiving a session on an ssh:// workspace now also removes its exec-side home (`~/.kimi-code/remote-sessions/<sessionId>`) on the remote host, so shell snapshots and plan files no longer accumulate there; the cleanup is best-effort and never fails the close.
