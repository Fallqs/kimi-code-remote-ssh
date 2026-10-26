Read the current agent session's idle auto-compaction settings without changing them.

Returns `on`, `minutes`, and `lower_bound`. Before the first `idc_switch` call, `on` is false and the other fields show the defaults a switch call would currently use. After a switch call, returns the resolved session settings, which remain fixed across model changes.
