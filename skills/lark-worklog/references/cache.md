# Local work-log cache

Use this cache only as a same-day, read-only mirror of the selected work-log spreadsheet. Lark remains the source of truth. The cache stores the selected workbook identity plus the text read model for columns A and B after preflight; it never stores linked document bodies and it has no operation for patching task data locally.

## Contents

1. [Consistency contract](#consistency-contract)
2. [Read fast path](#read-fast-path)
3. [Build or refresh a snapshot](#build-or-refresh-a-snapshot)
4. [Sheet write protocol](#sheet-write-protocol)
5. [Manual edits and recovery](#manual-edits-and-recovery)
6. [Storage and identity](#storage-and-identity)

## Consistency contract

- Treat this Skill on one machine as the only routine writer to the work-log spreadsheet.
- Do not check a time-to-live or remote revision for a clean cache prepared for today's local date. A clean same-day hit is the read path.
- Never use cached content as a write precondition. Resolve every target cell from a complete live read while holding the cache write lease.
- Mark the cache dirty before the first sheet mutation. Replace it only from one complete, verified, post-write `A:B` live read.
- Treat a missing, dirty, corrupt, ambiguous, or different-date cache as a live-refresh requirement.
- Bypass the cache when the user explicitly asks to refresh, says they edited the sheet manually, switches the authenticated Lark identity, switches targets, asks about an older date, or needs linked-document content.
- Keep one writer machine. Caches on different machines do not synchronize; if the Skill runs on several machines, choose one writer or force a live refresh before reads on every machine.

## Read fast path

Compute today's process-local date, then query the cache before loading any official Lark Skill for a read-only request limited to current tasks or today's entries:

```bash
node <skill-directory>/scripts/worklog-rules.cjs date
node <skill-directory>/scripts/worklog-cache.cjs get --date <YYYY-MM-DD>
```

Interpret the result:

- `status: "hit"` — answer from `snapshot.rows`. Use `snapshot.target` as the selected workbook for the conversation. State the cache's `fetched_at` time when freshness matters. Do not call Lark merely to validate the hit.
- `reason: "identity_ambiguous"` — load `lark-shared`, resolve the current verified user identity, and retry with `--identity-key <tenant-and-open-id>`.
- `reason: "date_mismatch"` or a dirty reason with `target` — reuse that exact target for live preflight and refresh; do not repeat Drive search.
- `reason: "write_in_progress"` — another task owns the writer lease. Wait briefly and retry. Do not read Lark or serve the prior snapshot concurrently with that writer.
- Any other miss — follow normal target discovery and live preflight.

The cached rows contain physical row number, title, aliases, status, task notes, `daily_text`, and parsed `daily_items`. They intentionally omit task-document mention tokens, hyperlinks, styles, and historical date columns.

## Build or refresh a snapshot

After target discovery and successful monthly/daily preflight:

1. Resolve the authenticated user identity through `lark-shared`. Use a stable key containing tenant identity and the verified user `openId`; never infer it from a task owner or collaborator.
2. Read `A1:B<physical-row-count>` from the current-month sheet with `+cells-get --include value`. Inspect completeness exactly as required by [worklog-format.md](worklog-format.md).
3. Feed the untouched successful `cells-get` JSON envelope to `replace`. Prefer a direct stdout pipe so the full snapshot never enters model context or a project file; keep stderr separate and never use `2>&1`:

   ```bash
   lark-cli sheets +cells-get \
     --spreadsheet-token <spreadsheet-token> \
     --sheet-id <current-month-sheet-id> \
     --range 'A1:B<physical-row-count>' \
     --include value --as user | \
   node <skill-directory>/scripts/worklog-cache.cjs replace \
     --identity-key <tenant-and-open-id> \
     --workbook-token <spreadsheet-token> \
     --workbook-title '<title-containing-[worklog]>' \
     --sheet-id <current-month-sheet-id> \
     --date <YYYY-MM-DD>
   ```

`replace` accepts only a complete, contiguous A:B range beginning at row 1, requires B1 to equal today's expected header, trims trailing empty physical rows, writes a temporary file with mode `0600`, and atomically renames it over the prior snapshot. A failed validation leaves the previous cache unchanged.

Use the same replacement path after creating a workbook, changing targets, or explicitly refreshing after a manual edit.

## Sheet write protocol

Use the lease for every operation that may mutate the spreadsheet, including daily items, aliases, statuses, task rows, and automatic day/month rollover. Task-document-only writes do not change the A:B cache and do not require this lease.

1. Acquire the lease before the first live read used to plan a sheet write:

   ```bash
   node <skill-directory>/scripts/worklog-cache.cjs begin-write \
     --identity-key <tenant-and-open-id>
   ```

   Capture the returned `owner`. The command atomically creates the per-identity writer lock and marks any existing snapshot dirty.

2. Perform live target reads, sheet writes, and mandatory read-back verification while retaining that owner value. Never plan the write from `snapshot.rows`.
3. After every sheet effect is verified, read the complete current A:B range again and finish atomically:

   ```bash
   lark-cli sheets +cells-get \
     --spreadsheet-token <spreadsheet-token> \
     --sheet-id <current-month-sheet-id> \
     --range 'A1:B<physical-row-count>' \
     --include value --as user | \
   node <skill-directory>/scripts/worklog-cache.cjs finish-write \
     --identity-key <tenant-and-open-id> \
     --owner <lease-owner> \
     --workbook-token <spreadsheet-token> \
     --workbook-title '<title-containing-[worklog]>' \
     --sheet-id <current-month-sheet-id> \
     --date <YYYY-MM-DD>
   ```

4. If any write, verification, or final snapshot read fails, release the lease while keeping the cache dirty:

   ```bash
   node <skill-directory>/scripts/worklog-cache.cjs abort-write \
     --identity-key <tenant-and-open-id> \
     --owner <lease-owner> \
     --reason write_reconciliation_required
   ```

Never clear dirty state by patching the old snapshot. The next operation must reconcile live state and run `replace`.

## Manual edits and recovery

When the user says they changed the work-log spreadsheet manually, treat that statement as cache invalidation. Skip a possible cache hit, run live preflight against the cached target, read complete A:B, and replace the snapshot.

If a process terminates while holding the lease, subsequent reads return `write_in_progress`. A lease becomes recoverable after 30 minutes. Only after reading and reconciling the complete live A:B state may an agent run `replace --recover`; never use recovery merely to bypass an active writer.

If a cached target is inaccessible, stop and report it. Do not silently search for and switch to another `[worklog]` workbook. Rediscover only when the user explicitly requests target rediscovery or switching.

## Storage and identity

The helper uses these default cache roots:

- macOS: `~/Library/Caches/lark-worklog`
- Linux: `${XDG_CACHE_HOME:-~/.cache}/lark-worklog`
- Windows: `%LOCALAPPDATA%\lark-worklog\cache`

`LARK_WORKLOG_CACHE_DIR` or `--cache-dir` may override the location for a controlled runtime or tests. The directory uses mode `0700` and snapshot files use `0600` on POSIX systems. File names are SHA-256 hashes of the identity key; raw user identity is not stored. Cache content remains sensitive because it includes task titles and today's work items. Never commit, log, attach, or copy these files into the repository.

Changing the authenticated Lark account or profile requires an explicit live refresh under the new identity. When more than one identity cache exists, `get` refuses to choose one without `--identity-key`.
