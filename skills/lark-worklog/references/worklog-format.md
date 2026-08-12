# Work-log format and write procedures

Read this reference before writing the spreadsheet or a linked task document.

## Contents

1. [Private target configuration](#private-target-configuration)
2. [Workbook model](#workbook-model)
3. [Creating a workbook](#creating-a-workbook)
4. [Daily entries](#daily-entries)
5. [Task identity and metadata](#task-identity-and-metadata)
6. [Creating a task](#creating-a-task)
7. [Maintaining task documents](#maintaining-task-documents)
8. [Legacy colors](#legacy-colors)
9. [Verification and failures](#verification-and-failures)

## Private target configuration

`worklog.cjs` stores this schema outside repositories:

```json
{
  "version": 1,
  "default_spreadsheet_url": "https://tenant.example/sheets/example-token",
  "timezone": "Asia/Shanghai"
}
```

The script removes query parameters and fragments, validates the workbook through `lark-cli`, and writes the directory as `0700` and the file as `0600` on POSIX. It stores no Lark access or refresh token. Set `LARK_WORKLOG_CONFIG_DIR` only for tests or an intentional alternate private location.

When a user supplies a different valid work-log link, run `configure`; it becomes the new default. Do not treat a one-off validation copy as the new default—use an isolated `LARK_WORKLOG_CONFIG_DIR` for that validation.

## Workbook model

- Name monthly sheets `YYYYMM`, newest first.
- Freeze row 1 and column A.
- Reserve column A for stable task identity; insert daily columns immediately before the current B column so dates remain newest first.
- Keep A1 untouched. Put `杂项` in A2. Treat rows 3 onward as tasks.
- Format date headers as `YYYY/MM/DD EnglishWeekday`, for example `2030/01/02 Wednesday`.
- Preserve sheet history: copying a month intentionally retains previous date columns.
- Preserve the reference layout:
  - Column A width: 486 px.
  - Daily column width: 411 px.
  - Font size: 16 px; vertical alignment: middle.
  - Date header: `#3370ff` background, white bold text, left aligned.
  - A1: `#dee0e3` background. Leave its content empty for a new workbook.

Run `prepare --dry-run` to inspect month/day operations without mutation. `prepare` uses only explicit `状态：已完成` lines for monthly cleanup and never interprets background color.

## Creating a workbook

Create a workbook only after explicit authorization. Use the user's timezone and compute the current month and date header first.

Create the current month with untyped text and styles in one call. Use stdin for the JSON payloads in real execution:

```bash
lark-cli sheets +workbook-create --title "工作日志" \
  --sheets '{"sheets":[{"name":"<YYYYMM>","header":false,"columns":["task","day"],"data":[["","<date header>"],["杂项",""]],"dtypes":{"task":"object","day":"object"}}]}' \
  --styles '{"styles":[{"name":"<YYYYMM>","cell_styles":[{"range":"A1","background_color":"#dee0e3","font_color":"#ffffff","font_size":16,"font_weight":"bold","vertical_alignment":"middle"},{"range":"B1","background_color":"#3370ff","font_color":"#ffffff","font_size":16,"font_weight":"bold","horizontal_alignment":"left","vertical_alignment":"middle"},{"range":"A2:B2","font_size":16,"vertical_alignment":"middle"}],"row_sizes":[{"range":"1:2","type":"auto"}],"col_sizes":[{"range":"A","type":"pixel","size":486},{"range":"B","type":"pixel","size":411}]}]}'
```

Read the returned workbook URL and sheet ID, then freeze both dimensions with one batch:

```json
[
  {"shortcut":"+dim-freeze","input":{"sheet_id":"<sheet-id>","dimension":"row","count":1}},
  {"shortcut":"+dim-freeze","input":{"sheet_id":"<sheet-id>","dimension":"column","count":1}}
]
```

Run `configure` on the returned URL and re-read A1:B2 plus the frozen dimensions. Do not add sample tasks or copy private template content.

## Daily entries

Use one item per line:

```text
[] Open work
[x] Work completed today
[~] Progress or context that remains relevant tomorrow
```

When adding an item:

1. Use `inspect` to resolve row 2 or a unique task row and today's column.
2. Read the target cell with `+cells-get --include value,style`.
3. Append or update exactly one logical line. Keep all unrelated lines in their original order.
4. Write the single cell with `+cells-set`; omit style fields so the existing copied style remains unchanged.
5. Re-read the cell and assert the intended line exists exactly once.

Marking an existing daily todo complete means replacing its leading `[]` with `[x]`; do not append a duplicate completed line. Record ongoing information as `[~]` rather than pretending it is complete.

On rollover, carry `[]`, `[~]`, and unknown legacy text. Remove only lines beginning with `[x]` or `[X]`. This conservative rule avoids silently losing legacy content.

## Task identity and metadata

Use this visible format in column A:

```text
<primary document mention or title>
别名：alias one、alias two
状态：已完成
```

Omit the alias line when empty and the status line while active. Keep metadata on separate lines so it remains parseable.

Normalize Unicode case, surrounding whitespace, and punctuation when comparing names, but preserve the user's original spelling when storing a confirmed alias. Deduplicate aliases case-insensitively.

When updating aliases or status:

1. Read the full cell with `+cells-get --include value,style`.
2. Preserve every mention and link object from `rich_text`.
3. Remove only existing `别名：` and `状态：` text lines.
4. Append the newly rendered metadata lines.
5. Write the complete reconstructed `rich_text` with `+cells-set`; do not send a background color.
6. Re-read `value,style` and assert that links, mentions, metadata, and background are unchanged except for the requested metadata.

For an ambiguous abbreviation, offer no more than three likely active tasks. After confirmation, add the exact abbreviation to the selected row before applying the requested maintenance.

Task completion requires an explicit user statement about the whole task. Never infer it merely because today's daily items are all `[x]`.

## Creating a task

Insert new tasks at row 3.

1. Create a document in `my_library` before touching the sheet. Escape XML text (`&`, `<`, `>`) and start with:

   ```xml
   <title>Task title</title>
   <h1>背景</h1><p>Use the user's supplied context; otherwise keep this section concise.</p>
   <h1>目标</h1><p>Use the stated outcome.</p>
   <h1>相关资料</h1>
   <h1>决策记录</h1>
   ```

2. Keep the returned document URL and token. Stop if creation fails.
3. Read row 3 style, borders, and row height. The current `lark-cli` inserts after `position`, so insert after row 2 (`position: 2`) to create row 3 with `inherit_style: after`; `+dim-insert` does not inherit row height, so include `+rows-resize` in the same batch.
4. Write A3 as a document mention (`type: mention`, `mention_type: 22`, returned token, task title). Add aliases as a following text segment when supplied.
5. Write any initial daily item to today's column in the same batch.
6. Re-read A3 and today's cell. Assert the mention token, title, aliases, item, style, and row height.

If the document succeeds but the sheet batch fails, retain the document, report its URL, re-read the sheet, and retry the linking operation. Do not create a second document and do not delete the first one automatically.

## Maintaining task documents

Use the first and only document mention as the primary document. If there is none, create the four-section document and link it before adding long-form information. If several document mentions exist, ask which is primary; after confirmation, move other links into `相关资料` and keep one primary mention in column A.

For links, PRDs, designs, tickets, and related artifacts:

1. Fetch the document outline.
2. Fetch the `相关资料` section with block IDs.
3. Insert the new link after the last block in that section. If the section does not exist, append the heading and content.

For decisions:

1. Use the same flow for `决策记录`.
2. Prefix the inserted paragraph with the current local date.
3. Preserve the user's rationale and alternatives when provided.

For background or goal changes, update the matching section surgically. Prefer `block_insert_after`, `block_replace`, or a narrow `str_replace`. Never use `overwrite` just to add information. Preserve images, file blocks, document mentions, comments, and unrelated sections.

After every document update, fetch the changed section again and verify the new content and existing resources.

## Legacy colors

`inspect` returns `legacy_color_candidates` containing every active row whose A cell has a background. This is a neutral candidate list, not a completion classification.

1. Present task titles and colors to the user and request row-by-row confirmation.
2. Add `状态：已完成` only to confirmed tasks.
3. Preserve all background colors exactly.
4. Ignore colors forever after textual migration; do not maintain a color-to-status mapping.

Do not block ordinary work-log maintenance on an optional migration unless a month rollover would otherwise need those statuses.

## Verification and failures

- Before every write, identify the exact workbook, sheet ID, row, column, and affected range.
- Batch dependent sheet mutations and keep destructive row ranges in descending order.
- Re-read every written range. For structural changes, also re-read workbook and sheet metadata.
- If a task row moves, discard cached row numbers and run `inspect` again.
- If the exact previous month is missing, stop with `PREVIOUS_MONTH_MISSING`; do not copy an older month.
- If today's header appears more than once, stop with `DUPLICATE_TODAY_COLUMNS` and ask the user to resolve the duplicate.
- If the target lacks a `YYYYMM` sheet or A2 is not `杂项`, stop and request migration approval instead of reshaping it silently.
- Do not start a new login for `EPERM`, Keychain write failures, DNS failures, or timeouts. Fix the execution environment or retry the same authenticated command first.
