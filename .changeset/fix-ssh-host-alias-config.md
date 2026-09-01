---
"@moonshot-ai/kimi-code": patch
---

Fix ssh:// workspaces failing to connect with "Permission denied" when the host is a Host alias whose key, proxy, or other settings live in its ~/.ssh/config stanza.
