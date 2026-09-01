---
"@moonshot-ai/kimi-code": patch
---

The v2 engine's Edit tool now matches tolerantly against Read view artifacts (shown `\r` escapes, a trailing-newline difference) and reports when a match required normalization, instead of failing with `old_string not found`.
