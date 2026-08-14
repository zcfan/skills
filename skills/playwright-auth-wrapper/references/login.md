# Login

Use Login only when the user explicitly asks to establish, refresh, or replace shared browser authentication. Login uses a named `playwright-cli` session and saves state only after the user confirms that login is complete.

## Start

```bash
node <skill-directory>/scripts/login_and_save_state.cjs start \
  --url "https://example.com/login"
```

This opens a headed CLI session and returns `sessionName` plus its command prefix. Leave it running. The user can log in manually; when the Agent must interact with the page, use the returned session with the official `playwright-cli` Skill:

```bash
playwright-cli -s=<sessionName> snapshot
playwright-cli -s=<sessionName> click <target>
```

Run those commands from the same working directory used to start the session.

## Save or cancel

Only after the user explicitly confirms that login is complete, save the session:

```bash
node <skill-directory>/scripts/login_and_save_state.cjs save \
  --session <sessionName>
```

The save command writes to a temporary file, validates the result, atomically replaces the shared state under the writer lock, and closes the login session. If saving fails, the existing state remains unchanged.

If the user cancels, close without saving:

```bash
node <skill-directory>/scripts/login_and_save_state.cjs cancel \
  --session <sessionName>
```
