---
"@moonshot-ai/kimi-code": patch
---

Make Edit tolerant of text copied from Read output: a shown \r in mixed-line-ending files and one extra trailing newline in old_string now match automatically (noted in the result), and a mismatch caused by leftover line-number prefixes names the cause.
