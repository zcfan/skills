---
name: lark-worklog
description: Record and track work progress by maintaining a structured personal Lark/Feishu spreadsheet discovered by the literal [worklog] title marker, with a same-day local read cache. Use when the user records fragmented work todos or progress, marks work complete, adds task aliases, creates a new work-log task and its long-lived document, updates related links or design decisions, rolls the log into a new day or month, inspects current work, refreshes after a manual sheet edit, or authorizes creation of a new work log. Requires the official lark-shared, lark-drive, lark-sheets, and lark-doc skills for live operations.
---

# Lark Worklog

Maintain a structured Lark spreadsheet as the source of truth for the user's work. Record todos and progress, preserve task context in linked documents, and keep the log current across days and months. Use a same-day local A:B snapshot for fast current-work reads while keeping all mutations remote-first.

## Required official Lark skills

Require all four official skills:

- `lark-shared` — authentication, identity, scopes, credential persistence, and error handling.
- `lark-drive` — title-based cloud search and resource discovery.
- `lark-sheets` — workbook validation, sheet structure, cells, rich text, styles, and batch operations.
- `lark-doc` — task-document creation, fetch, and surgical updates.

Before any live Lark read or write, confirm that `lark-cli` and all four skills are available in the current agent runtime. Load `lark-shared` first, then load `lark-drive`, `lark-sheets`, or `lark-doc` before using that domain. A clean same-day local cache hit for a read-only current-work request requires no Lark operation and may run before this dependency check.

If the binary or any required skill is unavailable, stop the work-log operation. Tell the user that `lark-worklog` depends on the official LarkSuite CLI skill set and direct them to the [official installation guide](https://github.com/larksuite/cli#installation--quick-start). Recommend exactly:

```bash
npx @larksuite/cli@latest install
```

Then explicitly offer to follow the official guide and perform the installation and verification for the user. Ask whether they want you to do that now, and do not run the installer until they agree. After installation, ask the user to reload the agent so the official skills become discoverable. Once the dependencies exist, use their documented operations and follow `lark-shared` for configuration and authorization.

## Start or resume a work-log conversation

1. Compute the current work-log date from the Agent process's local clock:

   ```bash
   node <skill-directory>/scripts/worklog-rules.cjs date
   ```

2. Read [references/cache.md](references/cache.md). For a read-only request limited to current tasks or today's entries, call `worklog-cache.cjs get` before loading the official Lark skills. On a clean same-day hit, answer immediately from the snapshot and reuse its target for this conversation. Bypass the cache for explicit refreshes, reported manual edits, target or identity changes, historical dates, and linked-document content.
3. When live Lark access is required, check the dependencies above. Reuse that check while the runtime remains unchanged.
4. Reuse the exact target from conversation context or a cache miss that returned target metadata. Do not call Drive search unless no reusable target exists or the user explicitly asks to rediscover or switch. If a reused target is inaccessible or invalid, stop and report it instead of silently searching for another workbook.
5. Only when no selected target exists, load `lark-drive` and search as the authenticated user for spreadsheet titles containing the literal, case-sensitive marker `[worklog]`:

   ```bash
   lark-cli drive +search --query '[worklog]' --only-title \
     --doc-types sheet --created-by-me --page-size 20 --as user --format json
   ```

6. Treat `--created-by-me` as original-creator semantics: only spreadsheets created by the current logged-in user qualify, even if ownership later changed. Keep only results whose returned title actually contains the literal, case-sensitive substring `[worklog]`; search matching is broader than this final check. Preserve API result order. If necessary, follow `page_token` until a second exact match is found or results are exhausted.
7. If no exact match exists, ask for authorization to create `工作日志 [worklog]` as the current user. If the user explicitly requests another spreadsheet, validate its creator, title marker, and structure before selecting it for the current conversation.
8. If exactly one match exists, select it. If multiple matches exist, select the first exact match in API result order, identify its title and URL, and warn that stable behavior requires exactly one spreadsheet whose title contains `[worklog]`. Never switch to a later result because the first is malformed or inaccessible.
9. Load `lark-sheets`, resolve the selected result, and inspect its structure. If it differs from the reference format, continue with a compatible interpretation only when the task and required cells map unambiguously without destructive reshaping. Otherwise ask whether to convert the workbook or create a compliant one.
10. Read [references/worklog-format.md](references/worklog-format.md). Run monthly and daily preflight when no clean same-day cache exists, the date or month changed, the user requested a refresh, or a structural failure occurred.
11. When preflight requires month or date rollover, immediately tell the user that structural rollover and verification can make the request slower, reassure them that work is continuing, acquire the cache writer lease, and proceed without redundant permission.
12. After successful live preflight, read complete `A1:B<physical-row-count>`. Use `finish-write` when preflight mutated the sheet under a lease; otherwise use `replace`. This establishes the fast path for subsequent same-day reads.
13. Re-read the current sheet after structural changes. Treat live workbook metadata and cells as the source of truth for every write; never reuse row or column coordinates after a structural change.

### Fast paths

- For read-only current-work requests, use a clean same-day local snapshot without Drive search, workbook inspection, header reads, or Lark dependency loading.
- Reuse the selected workbook identity from cache or conversation context without Drive search.
- After a successful live preflight, remember the prepared local date and current-month sheet ID in conversation context. If both still match, skip discovery and rollover checks.
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
- Before the first live read used to plan any sheet mutation, acquire the per-identity writer lease and mark the cache dirty with `worklog-cache.cjs begin-write`. Never plan a write from cached rows.
- Follow the current `lark-sheets` instructions for every table operation, including style inheritance, stdin payloads, high-risk confirmation, and mandatory read-back verification.
- Read [references/status-updates.md](references/status-updates.md) before changing aliases or statuses in rich-text task cells.
- Follow the current `lark-doc` instructions for every task-document operation. Create the document before inserting a new task row, and update existing documents surgically rather than overwriting them.
- Never assume a failed batch rolled back every successful child operation. Parse per-operation results, re-read affected ranges, and reconcile actual state before retrying.
- After all sheet effects are verified, read the complete live A:B snapshot and call `worklog-cache.cjs finish-write` with the lease owner. On any write, verification, or refresh failure, call `abort-write`; leave the cache dirty until a complete live reconciliation replaces it.
- Do not acquire the sheet-cache lease for an operation that changes only a linked task document and leaves the spreadsheet untouched.
- If document creation succeeds but a later sheet operation fails, retain and report that document URL. Resume with the same document; never create a duplicate or delete the first document automatically.

## Respect boundaries

- Represent task completion only with an explicit `状态：已完成` line. Preserve background styles during ordinary maintenance.
- Never delete completed rows from an active month. Delete explicitly completed rows only from a newly copied month before creating its first current-month date column.
- Never copy an older month when the exact previous `YYYYMM` sheet is missing.
- Never create skipped daily columns; create only today's column from the latest prior populated date.
- Never modify A1. Leave it blank in a newly created workbook.
- Keep only the cache defined in [references/cache.md](references/cache.md): selected workbook metadata plus a normalized, complete same-day A:B text snapshot. Never cache historical columns, task-document bodies, document tokens, styles, credentials, or timezone configuration.
- Treat one machine running this Skill as the only routine spreadsheet writer. When the user reports a manual sheet edit, bypass the cache and replace it from live A:B before answering. Do not assume caches on different machines synchronize.
- Protect cache directories with mode `0700` and files with `0600` on POSIX. Never commit, log, attach, or copy cache files into the repository.
- Scope the preflight to work-log requests. This skill is not a scheduler and does not run before unrelated conversations.
