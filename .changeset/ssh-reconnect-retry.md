---
"@moonshot-ai/kimi-code": patch
---

On SSH workspaces, a tool call made while the connection is down now tries one reconnect and proceeds on success instead of failing immediately with a connection error.
