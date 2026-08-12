# Task status and rich-text updates

Read this reference when changing task statuses or aliases in column A, especially for multiple rows.

## Contents

- [Status model](#status-model)
- [Preserve rich text](#preserve-rich-text)
- [Fast batch status workflow](#fast-batch-status-workflow)
- [Rich-text shape](#rich-text-shape)
- [Partial failure recovery](#partial-failure-recovery)

## Status model

- `状态：已完成` — the task is complete. Remove its row only from a newly copied month.
- `状态：挂起` — the task is parked. Retain its row during month rollover.
- No `状态：` line — the task is active. Retain its row during month rollover.
- Preserve any other explicit status supplied by the user. Month rollover removes only the exact status `已完成`.

## Preserve rich text

Column A may contain document mentions and hyperlinks. Update it with `+cells-set` and a reconstructed `rich_text` array.

> **Warning:** Do not use `+cells-replace`, `+csv-put`, or a plain `value` write on column A or any rich-text cell. These operations write plain text and can remove mentions and hyperlinks.

The current `+cells-set` schema requires every document mention (`type: "mention"`, nonzero `mention_type`) to include both `mention_token` and `link`. A `+cells-get` response may omit `link`, so complete every document mention before writing:

1. Keep a returned `link` when present.
2. Prefer an exact document URL already returned by `lark-doc`, `lark-drive`, or retained in the current conversation.
3. A verified wiki URL pattern may be reused within the same workbook and conversation. Pass its base, such as `https://tenant.example/wiki`, to the helper; do not hardcode a tenant host or assume every document uses `/wiki/`.
4. If no verified URL or pattern exists, resolve the document through `lark-drive` before writing. Never omit `link` or invent an unverified route.

Build one link when a verified base URL is available:

```bash
node <skill-directory>/scripts/worklog-rules.cjs mention-link \
  --base-url "https://tenant.example/wiki" --token "<mention-token>"
```

Or complete every mention in a rich-text array:

```bash
node <skill-directory>/scripts/worklog-rules.cjs resolve-mentions \
  --document-base-url "https://tenant.example/wiki" < ./rich-text.json
```

## Fast batch status workflow

For one or many rows, keep the normal path to one bulk read, an optional document-link resolution pass, one bulk write, and one verification read.

1. Read the smallest contiguous A-column range containing all requested rows with `+cells-get --include value,style`. Use `row_indices` to map physical rows. Inspect `warning_message`, `truncated`, `has_more`, and `complete`; do not continue until every target cell's value and complete `rich_text` array have been returned.
2. Resolve all missing document links together. Reuse a verified document base URL within the conversation when applicable.
3. Generate all writes in one pass. The helper removes existing `状态：` lines, appends the requested status once, preserves every rich-text segment, and omits style fields:

   ```bash
   node <skill-directory>/scripts/worklog-rules.cjs set-status \
     --sheet-id "<sheet-id>" \
     --rows "8-19:已完成,20-21:挂起" \
     --document-base-url "https://tenant.example/wiki" \
     --writes-only < ./cells-get.json > ./status-writes.json
   ```

   A uniform status can use `--rows "8,10-20" --status "已完成"`. Status values are not restricted to the built-ins.

4. Submit once, then re-read the same A-column range:

   ```bash
   lark-cli sheets +cells-set --spreadsheet-token "<spreadsheet-token>" \
     --writes @./status-writes.json
   lark-cli sheets +cells-get --spreadsheet-token "<spreadsheet-token>" \
     --sheet-id "<sheet-id>" --range "A8:A21" --include value,style
   ```

5. Verify each requested row: the expected status appears exactly once, mention tokens are unchanged, every outgoing document mention had a link, and background colors are unchanged. Read responses may omit mention links, so use mention-token preservation plus successful schema-validated writes; inspect the document URL separately when clickability itself is in question.

`set-status` is a local planner: it performs no Lark I/O and all output is a dry-run plan. The actual write remains an explicit `lark-sheets` operation.

`@file` inputs must be relative to the current working directory. Prefer stdin (`--writes -`) when practical; when a file makes review or recovery easier, work in a private temporary directory and use a path such as `@./status-writes.json`.

### Rich-text shape

A read may return a document mention without `link`:

```json
[
  {"type":"mention","mention_type":22,"mention_token":"doc_main","text":"Task"},
  {"type":"text","text":"\n状态：挂起"}
]
```

The write must restore the URL and replace the status without adding styles:

```json
[[{
  "rich_text": [
    {"type":"mention","mention_type":22,"mention_token":"doc_main","text":"Task","link":"https://tenant.example/wiki/doc_main"},
    {"type":"text","text":"\n状态：已完成"}
  ]
}]]
```

The same rule applies to cells with several mentions: preserve every segment in order, populate every missing document link, and append one final status segment.

```json
[[{
  "rich_text": [
    {"type":"mention","mention_type":22,"mention_token":"doc_main","text":"Task","link":"https://tenant.example/wiki/doc_main"},
    {"type":"text","text":" / "},
    {"type":"mention","mention_type":22,"mention_token":"doc_prd","text":"PRD","link":"https://tenant.example/wiki/doc_prd"},
    {"type":"text","text":" / "},
    {"type":"mention","mention_type":22,"mention_token":"doc_design","text":"Design","link":"https://tenant.example/wiki/doc_design"},
    {"type":"text","text":"\n状态：挂起"}
  ]
}]]
```

## Partial failure recovery

`+cells-set --writes` is fail-fast and does not roll back successful writes.

1. Re-read the full affected A-column range.
2. Compare every requested row with the planned status and original mention tokens/background.
3. Regenerate and submit writes only for rows that did not reach the intended state.
4. Never retry the entire batch blindly.

The status transformation is idempotent, but limiting retries avoids unnecessary writes and keeps failure reporting precise.
