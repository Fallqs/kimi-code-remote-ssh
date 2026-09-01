---
"@moonshot-ai/kimi-code": patch
---

In stateful Bash mode, agent commands now always start in the session's working directory — the remembered directory only steers `!` commands — and `[bash state]` notes no longer report working-directory changes.
