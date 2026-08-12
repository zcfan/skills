---
name: lark-worklog
description: Record and track work progress by maintaining a structured personal Lark/Feishu spreadsheet discovered by the literal [worklog] title marker. Use when the user records fragmented work todos or progress, marks work complete, adds task aliases, creates a new work-log task and its long-lived document, updates related links or design decisions, rolls the log into a new day or month, inspects the current work-log structure, or authorizes creation of a new one. Requires the official lark-shared, lark-drive, lark-sheets, and lark-doc skills.
---

# Lark Worklog

Maintain a structured Lark spreadsheet as the source of truth for the user's work. Record todos and progress, preserve task context in linked documents, and keep the log current across days and months.

## Required official Lark skills

Require all four official skills:

- `lark-shared` — authentication, identity, scopes, credential persistence, and error handling.
- `lark-drive` — title-based cloud search and resource discovery.
- `lark-sheets` — workbook validation, sheet structure, cells, rich text, styles, and batch operations.
- `lark-doc` — task-document creation, fetch, and surgical updates.

Before any Lark read or write, confirm that `lark-cli` and all four skills are available in the current agent runtime. Load `lark-shared` first, then load `lark-drive`, `lark-sheets`, or `lark-doc` before using that domain.

If the binary or any required skill is unavailable, stop the work-log operation. Tell the user that `lark-worklog` depends on the official LarkSuite CLI skill set and direct them to the [official installation guide](https://github.com/larksuite/cli#installation--quick-start). Recommend exactly:

```bash
npx @larksuite/cli@latest install
```

Then explicitly offer to follow the official guide and perform the installation and verification for the user. Ask whether they want you to do that now, and do not run the installer until they agree. After installation, ask the user to reload the agent so the official skills become discoverable. Once the dependencies exist, use their documented operations and follow `lark-shared` for configuration and authorization.

## Start or resume a work-log conversation

1. On the first work-log request in a conversation, check the required dependencies above. Reuse that dependency check while the runtime remains unchanged.
2. Reuse the selected workbook from the current conversation when one has already been found. Keep its title, URL or token, and the selecting user identity only in conversation context. Do not call Drive search again in that conversation unless the user explicitly asks to rediscover or switch targets. If the reused target becomes inaccessible or invalid, stop and report it instead of silently searching for another workbook.
3. Only when the conversation has no selected target, load `lark-drive` and search as the authenticated user for spreadsheet titles containing the literal, case-sensitive marker `[worklog]`:

   ```bash
   lark-cli drive +search --query '[worklog]' --only-title \
     --doc-types sheet --created-by-me --page-size 20 --as user --format json
   ```

4. Treat `--created-by-me` as original-creator semantics: only spreadsheets created by the current logged-in user qualify, even if ownership later changed. Keep only results whose returned title actually contains the literal, case-sensitive substring `[worklog]`; search matching is broader than this final check. Preserve API result order. If necessary, follow `page_token` until a second exact match is found or results are exhausted.
5. If no exact match exists, ask for authorization to create `工作日志 [worklog]` as the current user. If the user explicitly requests another spreadsheet, validate its creator, title marker, and structure before selecting it for the current conversation. A supplied link is never persisted locally.
6. If exactly one match exists, select it for the rest of the conversation.
7. If multiple matches exist, select the first exact match in API result order for the rest of the conversation, but tell the user which title and URL were selected and warn: stable behavior requires exactly one spreadsheet whose title contains `[worklog]`. Never silently switch to a later result because the first is malformed or inaccessible.
8. Load `lark-sheets`, resolve the selected result, and inspect its structure. If it differs from the reference format, assess whether the task and required cells can still be mapped unambiguously. Continue with a compatible interpretation when no destructive reshaping is needed. If the meaning is ambiguous or the requested operation requires conversion, describe the mismatch and ask whether to convert the workbook or create a compliant one. Never reshape it without explicit authorization.
9. Compute the current work-log date from the Agent process's local clock:

   ```bash
   node <skill-directory>/scripts/worklog-rules.cjs date
   ```

10. Read [references/worklog-format.md](references/worklog-format.md). Run monthly and daily preflight when the conversation has not prepared this workbook for today's local date, when the date or month changed, or after a structural failure. Otherwise use the same-day fast path and read only the cells needed for the request.
11. When preflight detects that a month or date rollover is required, immediately tell the user that the structural rollover and verification can make this request a little slower than an ordinary update, reassure them that work is continuing, and then proceed without asking for redundant permission.
12. Re-read the current sheet after preflight. Treat live workbook metadata and cells as the source of truth; never reuse row or column coordinates after a structural change.

### Fast path within one conversation

- Reuse the selected workbook identity without Drive search.
- After a successful preflight, remember the prepared local date and current-month sheet ID in conversation context. If both still match, skip workbook discovery and rollover checks.
- Reuse a task title/alias-to-row index until a row insertion, row deletion, task identity edit, target switch, or structural failure invalidates it. Before writing, read each targeted cell and confirm that its title or mention token still matches; refresh column A only on mismatch.
- For explicit row requests, read those rows directly. For multiple status updates, use one contiguous `+cells-get`, one `+cells-set --writes`, and one verification read; read [references/status-updates.md](references/status-updates.md).
- Treat complete target-cell content as a write precondition. After every `+cells-get`, inspect `warning_message`, `truncated`, `has_more`, and `complete` when present. If the result is incomplete, narrow the range or continue the read until every target cell is complete; never transform or write from a clipped value or partial `rich_text` array.
- Consolidate independent sheet ranges into the fewest supported read calls. Do not run an explicit auth-status call before every business command; follow `lark-shared` only when authentication actually needs diagnosis.

## Interpret user input

- Put unassigned fragments in row 2 (`杂项`).
- Resolve task references against the primary title and `别名：` values read from column A.
- Accept a unique title or alias match. For an uncertain match, present at most three likely tasks and wait for confirmation; then add the user's expression as an alias.
- Use one logical daily item per line:
  - `[]` — open todo
  - `[x]` — completed item
  - `[~]` — progress or context that should carry to the next day
- Treat task-level completion separately from daily `[x]` items. Add `状态：已完成` only when the user explicitly completes the whole task.
- Use `状态：挂起` for a parked task. Retain suspended tasks during month rollover.
- Keep links, PRDs, designs, decisions, and long-form context in the primary task document. Keep the daily sheet concise.

## Apply writes

- Treat a clear maintenance request as authorization for its scoped Lark writes and automatic rollover. Ask again only for an ambiguous task, an inaccessible target, or a structural conversion that is not already explicit in the request.
- Follow the current `lark-sheets` instructions for every table operation, including style inheritance, stdin payloads, high-risk confirmation, and mandatory read-back verification.
- Read [references/status-updates.md](references/status-updates.md) before changing aliases or statuses in rich-text task cells.
- Follow the current `lark-doc` instructions for every task-document operation. Create the document before inserting a new task row, and update existing documents surgically rather than overwriting them.
- Never assume a failed batch rolled back every successful child operation. Parse per-operation results, re-read affected ranges, and reconcile actual state before retrying.
- If document creation succeeds but a later sheet operation fails, retain and report that document URL. Resume with the same document; never create a duplicate or delete the first document automatically.

## Respect boundaries

- Represent task completion only with an explicit `状态：已完成` line. Preserve background styles during ordinary maintenance.
- Never delete completed rows from an active month. Delete explicitly completed rows only from a newly copied month before creating its first current-month date column.
- Never copy an older month when the exact previous `YYYYMM` sheet is missing.
- Never create skipped daily columns; create only today's column from the latest prior populated date.
- Never modify A1. Leave it blank in a newly created workbook.
- Keep no persistent local configuration for this skill. Do not write a spreadsheet URL, timezone, document token, task content, or target-selection cache to disk. Conversation-local target reuse is required for speed and is discarded with the conversation. The official `lark-cli` may persist its own authentication and application configuration according to `lark-shared`; that state is external to this skill.
- Scope the preflight to work-log requests. This skill is not a scheduler and does not run before unrelated conversations.
