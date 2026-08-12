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

Then explicitly offer to follow the official guide and perform the installation and verification for the user. Ask whether they want you to do that now, and do not run the installer until they agree. After installation, ask the user to reload the agent so the official skills become discoverable. Do not create local substitutes, copy the official skills into this skill, or silently fall back to raw OpenAPI calls. Once the dependencies exist, follow `lark-shared` for configuration and authorization rather than duplicating its login flow here.

## Start or resume a work-log conversation

1. On the first work-log request in a conversation, check the required dependencies above. Reuse that dependency check while the runtime remains unchanged.
2. Reuse the selected workbook from the current conversation when one has already been found. Keep its title, URL or token, and the selecting user identity only in conversation context. Do not call Drive search again in that conversation unless the user explicitly asks to rediscover or switch targets. If the reused target becomes inaccessible or invalid, stop and report it instead of silently searching for another workbook.
3. Only when the conversation has no selected target, load `lark-drive` and search as the authenticated user for spreadsheet titles containing the literal, case-sensitive marker `[worklog]`:

   ```bash
   lark-cli drive +search --query '[worklog]' --only-title \
     --doc-types sheet --created-by-me --page-size 20 --as user --format json
   ```

4. Treat `--created-by-me` as original-creator semantics: only spreadsheets created by the current logged-in user qualify, even if ownership later changed. Keep only results whose returned title actually contains the literal, case-sensitive substring `[worklog]`; search matching is broader than this final check. Preserve API result order. If necessary, follow `page_token` until a second exact match is found or results are exhausted.
5. If no exact match exists, do not use an arbitrary spreadsheet. Ask whether to create `工作日志 [worklog]` as the current user, or ask the user to identify an existing spreadsheet originally created by the same current user and authorize adding `[worklog]` to its title. If an existing sheet was created by another identity, explain that renaming it will not make it discoverable under this policy; offer to create a new sheet or an authorized copy instead. A supplied link does not bypass the title or original-creator rules; after validation it may select the target for the current conversation but is never persisted locally.
6. If exactly one match exists, select it for the rest of the conversation.
7. If multiple matches exist, select the first exact match in API result order for the rest of the conversation, but tell the user which title and URL were selected and warn: stable behavior requires exactly one spreadsheet whose title contains `[worklog]`. Never silently switch to a later result because the first is malformed or inaccessible.
8. Load `lark-sheets`, resolve the selected result, and verify the work-log structure. Stop and request migration approval if it is invalid.
9. Compute the current work-log date from the Agent process's local clock:

   ```bash
   node <skill-directory>/scripts/worklog-rules.cjs date
   ```

   Do not read, copy, or manage the Playwright skills' browser timezone setting. It is unrelated to work-log target discovery and date rollover.

10. Read [references/worklog-format.md](references/worklog-format.md), then use `lark-sheets` to complete the monthly and daily preflight before interpreting the user's requested update.
11. When preflight detects that a month or date rollover is required, immediately tell the user that the structural rollover and verification can make this request a little slower than an ordinary update, reassure them that work is continuing, and then proceed without asking for redundant permission.
12. Re-read the current sheet after preflight. Treat live workbook metadata and cells as the source of truth; never reuse row or column coordinates after a structural change.

### Fast path within one conversation

- Reuse the selected workbook identity without Drive search.
- Reuse a successfully resolved current-month sheet ID while the local month is unchanged, but include the date-header row and A2 in the first live sheet read for each request. If B1 is not today's unique header or A2 is not `杂项`, leave the fast path and run the full preflight.
- Keep task rows and daily columns live: never cache row numbers, column letters, values, styles, or task matches across requests.
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
- Keep links, PRDs, designs, decisions, and long-form context in the primary task document. Keep the daily sheet concise.

## Apply writes

- Treat a clear maintenance request as authorization for its scoped Lark writes and automatic rollover. Ask again only for an ambiguous task, a structural migration, legacy-color interpretation, or an invalid target.
- Follow the current `lark-sheets` instructions for every table operation, including style inheritance, stdin payloads, high-risk confirmation, and mandatory read-back verification.
- Follow the current `lark-doc` instructions for every task-document operation. Create the document before inserting a new task row, and update existing documents surgically rather than overwriting them.
- Never assume a failed batch rolled back every successful child operation. Parse per-operation results, re-read affected ranges, and reconcile actual state before retrying.
- If document creation succeeds but a later sheet operation fails, retain and report that document URL. Resume with the same document; never create a duplicate or delete the first document automatically.

## Respect boundaries

- Never infer completion from background color; preserve all backgrounds unchanged.
- Never delete completed rows from an active month. Delete explicitly completed rows only from a newly copied month before creating its first current-month date column.
- Never copy an older month when the exact previous `YYYYMM` sheet is missing.
- Never create skipped daily columns; create only today's column from the latest prior populated date.
- Never modify A1. Leave it blank in a newly created workbook.
- Keep no persistent local configuration for this skill. Do not write a spreadsheet URL, timezone, document token, task content, or target-selection cache to disk. Conversation-local target reuse is required for speed and is discarded with the conversation. Do not read Playwright configuration. The official `lark-cli` may persist its own authentication and application configuration according to `lark-shared`; that state is external to this skill.
- Scope the preflight to work-log requests. This skill is not a scheduler and does not run before unrelated conversations.
