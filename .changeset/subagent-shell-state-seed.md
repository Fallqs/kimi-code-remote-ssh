---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
---

Subagents now start their stateful bash shell from the parent agent's committed shell snapshot at creation — for example an activated conda environment, exported variables, and shell functions — instead of starting cold. After creation the two shells diverge independently; later commits to either side never propagate.
