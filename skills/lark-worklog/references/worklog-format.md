# Work-log format and workflow

Read this reference before changing the spreadsheet or a linked task document. Use the official `lark-sheets` instructions for every spreadsheet command and the official `lark-doc` instructions for every document command; this file defines only work-log-specific policy.

## Contents

1. [Target discovery](#target-discovery)
2. [Workbook model](#workbook-model)
3. [Mandatory preflight](#mandatory-preflight)
4. [Local snapshot handoff](#local-snapshot-handoff)
5. [Complete cell reads](#complete-cell-reads)
6. [Creating a workbook](#creating-a-workbook)
7. [Inspecting and resolving tasks](#inspecting-and-resolving-tasks)
8. [Daily entries](#daily-entries)
9. [Task identity and metadata](#task-identity-and-metadata)
10. [Creating a task](#creating-a-task)
11. [Maintaining task documents](#maintaining-task-documents)
12. [Verification and failures](#verification-and-failures)

## Target discovery

Reuse an exact target from a clean cache, a dirty/different-date cache miss that returned target metadata, or conversation context. Discover a workbook only when none of those sources provides a target.

1. If the current conversation or cache already selected a workbook, reuse its token without Drive search. Do not silently change it. Search again only when the user explicitly requests rediscovery or target switching; if the target becomes inaccessible, stop and report that fact.
2. Otherwise load `lark-drive` and search as the authenticated user:

   ```bash
   lark-cli drive +search --query '[worklog]' --only-title \
     --doc-types sheet --created-by-me --page-size 20 --as user --format json
   ```

3. `--created-by-me` uses original-creator semantics. Keep only spreadsheets originally created by the current logged-in user, then keep only results whose returned title contains the literal, case-sensitive substring `[worklog]`. Do not accept a broad semantic match such as `worklog` without brackets.
4. Preserve API result order. The first exact match is the selected target. Continue pagination only until a second exact match is found or `has_more` becomes false; this is enough to decide whether the marker is unique.
5. With one match, continue silently. With multiple matches, continue with the first but immediately identify its title and URL and warn that exactly one `[worklog]` spreadsheet is required for stable selection. Search ranking can change, so “first” is a fallback rather than a durable identity.
6. With no match, ask the user to authorize creation of `工作日志 [worklog]` as the current user. If the user explicitly requests another spreadsheet, validate its creator, literal title marker, and structure before selecting it. Persist its target metadata only after live preflight and a complete A:B snapshot succeed.
7. Load `lark-sheets` and inspect the selected first result. If it is inaccessible, stop and report it. If its structure differs from the reference format, keep this target and follow the compatibility rules below; do not silently fall through to a later candidate.

Search operates only on resources visible to the current authenticated Lark identity, requires `search:docs:read`, and requires a user identity so `--created-by-me` can resolve its open ID. Store only the selected title, workbook token, current-month sheet ID, month, and revision inside the protected cache defined in [cache.md](cache.md). Do not persist search result order, alternative candidates, credentials, or timezone configuration.

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

Complete both phases before creating a clean cache for a workbook and local date. Run them again when the cache is missing or dirty, the local date or month changes, the user requests a live refresh, after a target switch, or after a structural failure. A clean same-day cache proves that preflight completed when the snapshot was created and may serve read-only current-work requests without repeating either phase.

For speed, reuse the selected workbook, current-month sheet ID, prepared local date, and normalized A:B rows from [cache.md](cache.md). Cached task rows may answer read-only questions. For writes, use a complete targeted live read to confirm the expected title or mention token while holding the writer lease; invalidate any conversation row index after row insertion/deletion or a task identity edit.

If either phase needs a structural write, immediately send a short progress note before writing: explain that automatic date/month rollover plus read-back verification can make this request slightly slower than an ordinary log update, reassure the user that processing is continuing, acquire the cache writer lease, and do not ask for an extra confirmation.

### Month rollover

1. Use `lark-sheets +workbook-info` to list sheets and locate the current `YYYYMM`.
2. If the current month exists, do not copy or clean it again.
3. If it does not exist, require the exact previous month. If that sheet is missing, stop and ask the user; never select an older month.
4. Copy the exact previous month, rename the copy to the current `YYYYMM`, and move it to index 0. Re-read workbook metadata and verify its title, ID, and index before continuing.
5. Read column A in the new sheet. Identify completed tasks only by an independent, exact `状态：已完成` line. Retain `状态：挂起`, active rows with no status, and any other status.
6. Delete only completed task rows from the new sheet in descending row order. Preserve the previous month unchanged. Re-read column A and verify that no completed task remains.
7. Treat any failed structural batch as potentially partially applied. Re-read workbook metadata and affected rows before deciding whether to retry.

### Day rollover

1. Read the date-header row and parse every recognizable date column.
2. If today's date appears more than once, stop and ask the user to resolve the duplicate.
3. If today's date already exists once, do not insert another column.
4. Otherwise find the latest earlier date column that contains data. Do not create columns for skipped dates.
5. Read its values, cell styles, borders, and column width using `lark-sheets`. Use `actual_range`, `row_indices`, and `col_indices`; never infer physical rows from the returned array indexes. Build a dense row-to-value map through the real last task row so blank source cells cannot shift later rows.
6. Before writing, generate the deterministic coordinate plan:

   ```bash
   node <skill-directory>/scripts/worklog-rules.cjs day-plan \
     --source-column <source-column-before-insert> --last-row <last-task-row>
   ```

7. Insert exactly one column before B with `+dim-insert --position B --count 1 --inherit-style after`. The CLI's `--position` is a before-position anchor: `B` creates the new B and shifts the existing columns from B onward one place right. Use no other structural operation for day rollover.
8. After insertion, use the plan's shifted source coordinate. Copy formats only from that shifted source into B, set B's width from the pre-insert source width, and write the dense transformed value matrix once. Do not copy `all`: carrying values is an explicit transformation and must not copy stale values or formulas implicitly. Keep these ordered operations in one `+batch-update`.
9. Set B1 to today's `YYYY/MM/DD EnglishWeekday` header. For rows 2 onward, carry `[]`, `[~]`, and unrecognized lines; remove only lines beginning with `[x]` or `[X]`. The helper can transform one cell deterministically:

   ```bash
   printf '%s' '<previous-cell-text>' | node <skill-directory>/scripts/worklog-rules.cjs carry
   ```

10. Re-read A1:B through the last task row and the header row after the batch. Verify that column A's values, rich-text mentions, links, and backgrounds match the pre-insert snapshot exactly; verify B's date, dense carried text, styles, borders, and width. If the structural action did not report a single insertion at B, stop and report the discrepancy.

## Local snapshot handoff

After a read-only live preflight succeeds without changing the sheet, read a complete contiguous `A1:B<physical-row-count>` range with values and pass the untouched `cells-get` envelope to `worklog-cache.cjs replace`. If preflight performed a month or day rollover under the writer lease, pass the post-rollover envelope to `finish-write` instead. The helper validates today's B1 header, trims trailing empty rows, normalizes task identity and daily items, and atomically replaces the same-user cache.

For every sheet mutation, acquire the cache writer lease before the live planning read. After remote verification, perform the same full A:B read and pass it to `finish-write`. On any failure, call `abort-write` so a subsequent read cannot serve the pre-write snapshot. Follow [cache.md](cache.md) for exact commands and recovery rules.

## Complete cell reads

Every cell used to identify a task, transform text, preserve rich text, carry a day, or verify a write must be read in full. Work-log cells are expected to be modest in size, so completeness takes priority over saving a small amount of output.

- Read the smallest useful range, but do not deliberately lower `--max-chars` enough to clip a target cell.
- Before using any `+cells-get` result, inspect `warning_message` first, then `truncated`, `has_more`, and `complete` when present. Also confirm `actual_range`, `row_indices`, and `col_indices` cover every requested cell.
- If any target is incomplete, do not infer the missing suffix and do not write. Narrow to the affected cell or smaller row window, then continue according to the CLI's pagination warning until the full value and full `rich_text` array are available.
- If the Agent's own stdout limit still clips a targeted response, use `--output-path` in a private temporary directory and accept the file only when its receipt reports `complete: true`; remove the temporary artifact after use. This is transient processing, not persistent Skill configuration.
- Apply the same completeness checks to verification reads. A visible status prefix is not proof that mentions, links, aliases, or trailing daily items survived.

## Creating a workbook

Create a workbook only after explicit authorization. Compute the current month and date header from the Agent process's local clock.

1. Use the official `lark-sheets +workbook-create` workflow as the current user to create a workbook titled `工作日志 [worklog]` with only the current `YYYYMM` sheet. Both the creator identity and marker are required for future discovery.
2. Initialize A1 as empty, A2 as `杂项`, and B1 as today's date header. Apply the reference layout above and freeze row 1 and column A.
3. Do not add sample tasks or copy private template content.
4. Re-read workbook metadata, A1:B2, styles, dimensions, and frozen panes.
5. After validation succeeds, create the protected same-day cache snapshot, then return the workbook title and URL to the user. Persist only the target metadata and A:B read model allowed by [cache.md](cache.md).

## Inspecting and resolving tasks

For a live path after preflight, read current workbook metadata, the header row, column A through the real last task row, and today's column. For a clean same-day read-only cache hit, use the equivalent normalized fields in `snapshot.rows`; do not use cached fields to plan a write.

For each task row, collect:

- physical row number;
- first visible line as the primary title;
- primary document mention token and URL, if present;
- `别名：` values;
- explicit `状态：已完成` state;
- today's daily text.

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

> **Warning:** If a daily cell contains rich text, mentions, or hyperlinks, do not use `+cells-replace`, `+csv-put`, or a plain `value` write. Reconstruct and write its `rich_text` with `+cells-set`. Plain-value writes are suitable only after a read confirms the cell is plain text.

## Task identity and metadata

Use this visible format in column A:

```text
<primary document mention or title>
别名：alias one、alias two
状态：已完成
```

Use `状态：已完成` for completed tasks and `状态：挂起` for parked tasks. Omit the alias line when empty and the status line while active. Preserve other explicit user-supplied statuses. Normalize Unicode case, surrounding whitespace, and punctuation when comparing names, but preserve the user's original spelling when storing a confirmed alias. Deduplicate aliases case-insensitively.

When updating aliases or status, read and follow [status-updates.md](status-updates.md). In summary:

1. Read the full cell with value, rich text, and style through `lark-sheets`.
2. Preserve every mention and hyperlink object. Restore required document `link` fields that `+cells-get` omitted; resolve unknown links before writing.
3. Remove only existing `别名：` and `状态：` text lines.
4. Append newly rendered metadata lines.
5. Write the reconstructed rich text through `+cells-set`, without style fields. Never use `+cells-replace` on the cell.
6. Re-read and verify metadata, mention tokens, and unchanged background. Verify returned links when available; otherwise validate the outgoing links separately as described in [status-updates.md](status-updates.md).

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

## Verification and failures

- Before every write, identify the exact workbook, sheet ID, row, column, and range.
- Hold the per-identity cache writer lease for every sheet mutation. Never use `--recover` to bypass a live writer.
- Keep destructive row ranges in descending order.
- Re-read every written range. For structural changes, also re-read workbook and sheet metadata.
- Treat a failed batch as potentially partially applied even if current CLI documentation describes transactional behavior.
- For `+cells-set --writes` partial failures, re-read all affected cells and retry only rows that did not reach the intended state. Do not resend the full batch.
- If a sheet write, read-back verification, or post-write A:B refresh fails, release the lease with `abort-write` and keep the cache dirty until a full live reconciliation succeeds.
- If today's header is duplicated, stop and ask the user to resolve it.
- If the target differs from the reference format, map its rows, columns, task identities, dates, and statuses before acting. Continue compatibly when that mapping is unambiguous and the requested write does not require destructive reshaping.
- If the mapping is ambiguous or the operation requires structural conversion, describe the mismatch and ask whether to convert the selected workbook or create a compliant one. A user's explicit request for a specific conversion is sufficient authorization for that conversion.
- Follow `lark-shared` for authentication failures. Do not treat filesystem, Keychain, DNS, or timeout failures as expired credentials.
