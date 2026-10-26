Configure idle auto-compaction for the current agent session. Use when the user asks to enable, disable, or change idle compaction.

Idle compaction starts disabled in every session, even when the active model has `idc_minutes`. Set `on: true` explicitly to enable it. `on` defaults to `false`, so omitting it disables idle compaction.

`minutes` defaults to the active model's `idc_minutes`; enabling fails if neither provides a positive value. `lower_bound` defaults to `loop_control.idc_lower_bound` (65,536 tokens when unset).

The resolved settings stay fixed when the model changes. A later call without `minutes` uses the then-current model's default. Enabling after the idle delay has already elapsed may compact immediately. Settings are live only and are not restored when a session is resumed.
