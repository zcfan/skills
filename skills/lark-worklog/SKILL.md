---
name: lark-worklog
description: Maintain a structured personal work log in a Lark/Feishu spreadsheet with the official lark-cli. Use when the user records fragmented work todos or progress, marks work complete, adds task aliases, creates a new work-log task and its long-lived document, updates related links or design decisions, rolls the log into a new day or month, inspects the current work-log structure, configures a default work-log spreadsheet, or authorizes creation of a new one.
---

# Lark Worklog

Use the official `lark-cli` as the only Lark interface. Use Node.js 18 or newer for the bundled script; do not introduce Python as a runtime dependency.

## Start every work-log request

1. Run authenticated CLI commands only where the user's Lark credential store is writable. Check the existing login before starting a new authorization flow. Treat filesystem, Keychain, DNS, and timeout failures as environment failures rather than expired credentials.
2. Locate this skill directory and run:

   ```bash
   node <skill-directory>/scripts/worklog.cjs prepare
   node <skill-directory>/scripts/worklog.cjs inspect
   ```

3. Run `prepare` before interpreting or writing the user's requested changes. It creates at most the current month and today's column, and is idempotent.
4. Use `inspect` as the row and document-token source of truth. Never reuse a row number from an earlier read after inserting or deleting rows.
5. Read [references/worklog-format.md](references/worklog-format.md) before any write, new-workbook creation, task-document creation, or legacy-color migration.

If no target is configured, ask for a spreadsheet link or permission to create a new work log. After receiving a link, configure it:

```bash
node <skill-directory>/scripts/worklog.cjs configure --url <spreadsheet-url> --timezone <iana-timezone>
```

An explicit valid link becomes the local default. Store no spreadsheet URL, document token, task content, or Lark credential inside the skill directory or another repository.

## Interpret user input

- Put unassigned fragments in row 2 (`杂项`).
- Resolve task references against the primary title and `别名：` values from `inspect`.
- Accept a unique title or alias match. For an uncertain match, present at most three likely tasks and wait for confirmation; then add the user's expression as an alias.
- Use one logical item per line:
  - `[]` — open todo
  - `[x]` — completed item
  - `[~]` — progress or context that should carry to the next day
- Treat task-level completion separately from daily `[x]` items. Add `状态：已完成` only when the user explicitly completes the whole task.
- Keep links, PRDs, designs, decisions, and long-form context in the task's primary document. Keep the daily sheet concise.

## Apply writes

- Treat a clear maintenance request as authorization for its scoped Lark writes and automatic rollover. Ask again only for an ambiguous task, a structural migration, legacy-color interpretation, or an invalid target.
- Read the exact target cell and its rich text before writing. Preserve unrelated lines, mentions, hyperlinks, style, borders, row height, and background.
- Combine multiple sheet mutations into one `lark-cli sheets +batch-update` request where useful, but never assume a failed batch rolled back every successful child operation. Parse per-operation results and re-read the affected rows before retrying. Pass large JSON through stdin.
- Create a task document before inserting its row. If document creation fails, do not write the row. If any later sheet operation fails, report the created document URL, re-read the sheet, and resume with that same document; never create a duplicate or delete the first document automatically.
- Update existing documents surgically with `docs +fetch` and block-level `docs +update`; never overwrite an existing document merely to add a link or decision.
- Re-read every changed cell or document section and compare it with the intended result before reporting completion.

## Respect boundaries

- Never infer completion from background color. `inspect` exposes colored rows only for one-time, user-confirmed migration; preserve those colors unchanged.
- Never delete completed rows from an active month. `prepare` deletes explicitly completed rows only in a newly copied month sheet before its first current-month date column is created.
- Never silently copy an older month when the exact previous `YYYYMM` sheet is missing.
- Never create skipped daily columns; create only today's column from the latest prior populated date.
- Never modify A1. Leave it blank in a newly created workbook.
- Scope the preflight to work-log requests. This skill is not a scheduler and does not run before unrelated conversations.
