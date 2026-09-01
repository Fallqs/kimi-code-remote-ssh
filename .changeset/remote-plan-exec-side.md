---
"@moonshot-ai/kimi-code": minor
---

On ssh:// remote workspaces, plan-mode plan files now live on the remote host (where the model's file tools write), so ExitPlanMode and plan revisions see what the model actually wrote; the server also gains POST /api/v1/sessions/{id}/shell for one-shot `!` commands.
