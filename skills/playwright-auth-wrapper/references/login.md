# Login

Use Login only when the user explicitly asks to add, refresh, or replace shared browser authentication. This is the only subflow that may write `storage-state.json`.

## Run Login

```bash
node <skill-directory>/scripts/login_and_save_state.cjs --url <target-login-or-app-url>
```

Useful options:

- `--headed`: show a visible browser when a desktop is available.
- `--timeout-ms <ms>`: extend the human-login window.
- `--auth-dir <dir>`: use the same non-default directory selected during Setup.
- `--screenshot <path>`: choose the screenshot path; the default is a private OS temporary directory.
- `--auto-authorize --authorize-host <exact-hostname>`: allow common authorization buttons on one exact host. Never enable this implicitly.

Load existing `storageState` first so login is incremental. When the script emits `ready-for-user`, show the screenshot in headless mode and let the user complete login. Use headed mode when typing or interaction is required.

Only after the user explicitly confirms completion, create the session-specific `saveMarkerPath` emitted by that process. Never reuse a marker from another login. The script then saves state and metadata atomically under the writer lock.

If the process times out, report that nothing was saved. Start a new Login only when requested.
