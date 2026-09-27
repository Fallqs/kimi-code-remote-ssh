---
"@moonshot-ai/kimi-code": minor
---

GOTO can now target any directory, not just the local kimi home: GOTO accepts an optional path argument — an absolute local path or an ssh://user@host/path spec to shadow into another remote host (ssh targets require `KIMI_CODE_EXPERIMENTAL_SSH_WORKDIR=1`).
