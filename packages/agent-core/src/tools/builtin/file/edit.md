Perform exact replacements in existing files.

- Edit is mandatory for every incremental change, especially small edits. DO NOT use Write or Bash `sed`.
- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed `old_string`.
- Take `old_string` and `new_string` from the Read output view.
- Drop the line-number prefix and tab; match only file content.
- `old_string` must be unique unless `replace_all` is set.
- If `old_string` is ambiguous, add surrounding context. Use `replace_all` only when every occurrence should change — for example, renaming a symbol throughout the file.
- Multiple Edit calls may run in one response only when they do not target the same file.
- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's `old_string`, causing `old_string not found`. Read the file again before the next Edit.
- A write lock serializes same-file edits in response order, but serialization does not make stale `old_string` valid.
- For pure CRLF files, Read shows LF; use LF in `old_string` and `new_string`, and Edit writes CRLF back.
- For mixed endings or lone carriage returns, Read shows carriage returns as \r; copy the shown \r verbatim — Edit unescapes it to a real carriage return automatically (for both strings) and reports the normalization. In LF or pure CRLF files a literal \r stays two characters.
- A trailing-newline difference at the end of `old_string` is tolerated and reported; `new_string` is always written literally.
- If a match fails because `old_string` still carries Read line-number prefixes (`N\t`), the error says so — Edit never strips them automatically; drop them yourself and retry.
