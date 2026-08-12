---
name: playwright-shared-auth-login
description: Maintain and update the shared Playwright storageState. Use when a user asks to add a site's login state, refresh expired browser login, open a visible login browser, persist browser authentication after the user says login is complete, or intentionally write back changes to the shared storageState. This is the only shared-auth skill that should modify storage-state.json.
---

# Playwright Shared Auth Login

Use this skill for the only workflow that writes shared `storage-state.json`.

Principles:

- Load any existing shared `storageState` first, so adding a new site is incremental.
- Open a browser at the user-provided URL and let the user complete login.
- Save only after explicit user confirmation. A timeout must leave the existing state unchanged.
- Serialize login writers with the auth-state lock. Normal automation tasks must never write shared state.
- Keep the existing locale, timezone, and headers configured by setup.

## Script

Run:

```bash
node <skill-directory>/scripts/login_and_save_state.cjs --url <target-login-or-app-url>
```

Useful options:

- `--headed`: show a visible local browser when a desktop is available.
- `--timeout-ms <ms>`: extend waiting time for human login.
- `--auth-dir <dir>`: use a non-default shared auth directory.
- `--screenshot <path>`: choose the screenshot path; the default uses the OS temporary directory.
- `--auto-authorize --authorize-host <exact-hostname>`: explicitly allow common authorization buttons to be clicked on one exact host. Never enable this implicitly.

When the script emits `ready-for-user`, send the screenshot to the user if running headless. Headless mode supports QR-based login; use `--headed` when the user must type or click. When the user explicitly confirms that login is complete, create the emitted session-specific `saveMarkerPath`. The script then writes state and metadata atomically.

Do not reuse a marker path from an earlier login session. If the timeout event is emitted, tell the user that nothing was saved and start a new login only if requested.

## Safety

Do not commit or paste `storage-state.json`. Keep the auth directory private. The script uses `0700` directories and `0600` state files and screenshots on POSIX systems. Logged and persisted URLs omit credentials, query parameters, and fragments. Parallel automation should use `$playwright-shared-auth-launch` instead.
