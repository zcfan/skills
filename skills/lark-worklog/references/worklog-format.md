# Work-log format and workflow

Read this reference before changing the spreadsheet or a linked task document. Use the official `lark-sheets` instructions for every spreadsheet command and the official `lark-doc` instructions for every document command; this file defines only work-log-specific policy.

## Contents

1. [Target discovery](#target-discovery)
2. [Workbook model](#workbook-model)
3. [Mandatory preflight](#mandatory-preflight)
4. [Creating a workbook](#creating-a-workbook)
5. [Inspecting and resolving tasks](#inspecting-and-resolving-tasks)
6. [Daily entries](#daily-entries)
7. [Task identity and metadata](#task-identity-and-metadata)
8. [Creating a task](#creating-a-task)
9. [Maintaining task documents](#maintaining-task-documents)
10. [Legacy colors](#legacy-colors)
11. [Verification and failures](#verification-and-failures)

## Target discovery

Keep no persistent local target configuration. Discover the workbook from live Drive search at the beginning of every work-log request.

1. Load `lark-drive` and search as the authenticated user:

   ```bash
   lark-cli drive +search --query '[worklog]' --only-title \
     --doc-types sheet --created-by-me --page-size 20 --as user --format json
   ```

2. `--created-by-me` uses original-creator semantics. Keep only spreadsheets originally created by the current logged-in user, then keep only results whose returned title contains the literal, case-sensitive substring `[worklog]`. Do not accept a broad semantic match such as `worklog` without brackets.
3. Preserve API result order. The first exact match is the selected target. Continue pagination only until a second exact match is found or `has_more` becomes false; this is enough to decide whether the marker is unique.
4. With one match, continue silently. With multiple matches, continue with the first but immediately identify its title and URL and warn that exactly one `[worklog]` spreadsheet is required for stable selection. Search ranking can change, so “first” is a fallback rather than a durable identity.
5. With no match, ask the user to authorize creation of `工作日志 [worklog]` as the current user, or to identify an existing spreadsheet originally created by the same current user and authorize adding `[worklog]` to its title. A sheet created by another identity remains excluded even after renaming; offer to create a new sheet or an authorized copy instead. Do not remember or directly reuse a supplied URL as a future override.
6. Load `lark-sheets` and validate the selected first result. If it is inaccessible or structurally invalid, stop and report it; do not silently fall through to a later candidate.

Search operates only on resources visible to the current authenticated Lark identity, requires `search:docs:read`, and requires a user identity so `--created-by-me` can resolve its open ID. The official `lark-cli` may persist its own credentials and application configuration, but `lark-worklog` must not persist a URL, token, timezone, result order, or selected target.

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

## Mandatory preflight

Complete both phases before processing every work-log maintenance request. Use live reads and make the process idempotent.

### Month rollover

1. Use `lark-sheets +workbook-info` to list sheets and locate the current `YYYYMM`.
2. If the current month exists, do not copy or clean it again.
3. If it does not exist, require the exact previous month. If that sheet is missing, stop and ask the user; never select an older month.
4. Copy the exact previous month, rename the copy to the current `YYYYMM`, and move it to index 0. Re-read workbook metadata and verify its title, ID, and index before continuing.
5. Read column A in the new sheet. Identify completed tasks only by an independent `状态：已完成` line.
6. Delete those task rows from the new sheet in descending row order. Preserve the previous month unchanged. Re-read column A and verify that no completed task remains.
7. Treat any failed structural batch as potentially partially applied. Re-read workbook metadata and affected rows before deciding whether to retry.

### Day rollover

1. Read the date-header row and parse every recognizable date column.
2. If today's date appears more than once, stop and ask the user to resolve the duplicate.
3. If today's date already exists once, do not insert another column.
4. Otherwise find the latest earlier date column that contains data. Do not create columns for skipped dates.
5. Read its values, cell styles, borders, column width, and the relevant row heights using `lark-sheets`.
6. Insert one column at B, preserving column A. Copy the source date column's dimensions and styles into the new B column according to the current official `lark-sheets` procedure.
7. Set B1 to today's `YYYY/MM/DD EnglishWeekday` header. For rows 2 onward, carry `[]`, `[~]`, and unrecognized legacy lines; remove only lines beginning with `[x]` or `[X]`. The helper can transform one cell deterministically:

   ```bash
   printf '%s' '<previous-cell-text>' | node <skill-directory>/scripts/worklog-rules.cjs carry
   ```

8. Re-read the complete new column and its structure. Verify the date, carried text, styles, borders, width, and row heights.

## Creating a workbook

Create a workbook only after explicit authorization. Compute the current month and date header from the Agent process's local clock. Do not read or manage the Playwright skills' browser timezone setting.

1. Use the official `lark-sheets +workbook-create` workflow as the current user to create a workbook titled `工作日志 [worklog]` with only the current `YYYYMM` sheet. Both the creator identity and marker are required for future discovery.
2. Initialize A1 as empty, A2 as `杂项`, and B1 as today's date header. Apply the reference layout above and freeze row 1 and column A.
3. Do not add sample tasks or copy private template content.
4. Re-read workbook metadata, A1:B2, styles, dimensions, and frozen panes.
5. After validation succeeds, return its title and URL to the user. Do not store either locally.

## Inspecting and resolving tasks

After preflight, read current workbook metadata, the header row, column A through the real last task row, and today's column.

For each task row, collect:

- physical row number;
- first visible line as the primary title;
- primary document mention token and URL, if present;
- `别名：` values;
- explicit `状态：已完成` state;
- today's daily text;
- background color only as a neutral legacy-migration candidate.

Resolve a task by exact normalized title or alias when unique. For fuzzy or multiple matches, present at most three likely active tasks. After confirmation, add the exact expression the user used as an alias before applying the requested update.

Discard all cached row numbers after inserting or deleting a row, then inspect again.

## Daily entries

Use one item per line:

```text
[] Open work
[x] Work completed today
[~] Progress or context that remains relevant tomorrow
```

When adding an item:

1. Resolve row 2 or one unique task and today's column from live reads.
2. Read the target cell with `lark-sheets`, including value and style.
3. Append or update exactly one logical line. Keep unrelated lines in their original order.
4. Write only the target cell; omit style fields so the copied style remains unchanged.
5. Re-read it and assert that the intended line exists exactly once.

Marking an existing daily todo complete means replacing its leading `[]` with `[x]`; do not append a duplicate completed line. Record ongoing information as `[~]`.

## Task identity and metadata

Use this visible format in column A:

```text
<primary document mention or title>
别名：alias one、alias two
状态：已完成
```

Omit the alias line when empty and the status line while active. Normalize Unicode case, surrounding whitespace, and punctuation when comparing names, but preserve the user's original spelling when storing a confirmed alias. Deduplicate aliases case-insensitively.

When updating aliases or status:

1. Read the full cell with value, rich text, and style through `lark-sheets`.
2. Preserve every mention and hyperlink object.
3. Remove only existing `别名：` and `状态：` text lines.
4. Append newly rendered metadata lines.
5. Write the reconstructed rich text without a background-color field.
6. Re-read and verify mentions, links, metadata, and unchanged background.

Task completion requires an explicit user statement about the whole task. Never infer it from daily `[x]` items.

## Creating a task

Insert new tasks at row 3.

1. Load `lark-doc` and create a document in `my_library` before touching the sheet. Start with `背景`, `目标`, `相关资料`, and `决策记录` sections. Use the user's supplied context and links; keep missing sections concise.
2. Keep the returned document URL and token. Stop if creation fails.
3. Load `lark-sheets`. Read row 3 style, borders, and height; insert a blank row after row 2 with style inheritance. Re-read rows 2–4 and verify that the previous row 3 moved to row 4. Restore the sampled row height if needed.
4. Write A3 as a document mention containing `type: mention`, `mention_type: 22`, the returned `mention_token`, task title in `text`, and the returned document URL in `link`. Add aliases as following text segments when supplied.
5. Re-read A3 and verify the mention before writing an optional initial daily item.
6. Re-read A3 and today's cell. Verify token, URL, title, aliases, daily item, style, and row height.

If any sheet operation fails after document creation, retain the document and resume with the same URL and token after reconciling actual sheet state. Never create a second document or delete the first one automatically.

## Maintaining task documents

Use the first and only document mention as the primary document. If there is none, create the four-section document and link it before adding long-form information. If several document mentions exist, ask which is primary; after confirmation, move the others into `相关资料` and keep one primary mention in column A.

Load `lark-doc` before every document operation:

- For links, PRDs, designs, tickets, and related artifacts, fetch the `相关资料` section and insert the new link locally.
- For decisions, insert a dated entry under `决策记录`, preserving rationale and alternatives when supplied.
- For background or goal changes, update only the matching section.
- Prefer block insertion, block replacement, or a narrow text replacement. Never overwrite the full document for a local update.

Fetch the changed section again and verify the new content and existing resources.

## Legacy colors

Background colors are migration candidates, never task status.

1. Collect active rows whose A cell has a background.
2. Present their task titles and colors and request row-by-row confirmation.
3. Add `状态：已完成` only to confirmed tasks.
4. Preserve every background exactly and ignore it for status afterward.

Do not block ordinary maintenance on optional color migration unless a month rollover needs explicit completion states.

## Verification and failures

- Before every write, identify the exact workbook, sheet ID, row, column, and range.
- Keep destructive row ranges in descending order.
- Re-read every written range. For structural changes, also re-read workbook and sheet metadata.
- Treat a failed batch as potentially partially applied even if current CLI documentation describes transactional behavior.
- If today's header is duplicated, stop and ask the user to resolve it.
- If the target lacks a usable monthly sheet or A2 is not `杂项`, request migration approval instead of reshaping it silently.
- Follow `lark-shared` for authentication failures. Do not treat filesystem, Keychain, DNS, or timeout failures as expired credentials.
