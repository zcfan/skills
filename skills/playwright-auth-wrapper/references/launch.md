# Launch

Use Launch for normal browser automation with the saved login state:

```bash
node <skill-directory>/scripts/open_with_shared_state.cjs \
  --url "https://example.com/app"
```

Options:

- `--url <url>` or a positional URL: optional initial page; defaults to `about:blank`.
- `--session <name>`: optional explicit CLI session name; otherwise Launch creates a unique name.
- `--auth-dir <dir>`: use the same non-default shared state directory selected during Setup.
- `--headed`: show the browser.

Launch runs the official `playwright-cli open` command with a fresh isolated session and the shared storage state. It returns `sessionName` and `commandPrefix` after the browser is ready. It does not take a screenshot, perform follow-up automation, save state, or close the browser.

## Hand the session to the Agent

Read and follow the official `playwright-cli` Skill for all subsequent work. Prepend the returned session name to every command and run from the same working directory:

```bash
playwright-cli -s=<sessionName> snapshot
playwright-cli -s=<sessionName> goto "https://example.com/next"
playwright-cli -s=<sessionName> click <target>
playwright-cli -s=<sessionName> screenshot
```

The Agent decides which commands to run and when the session is no longer needed:

```bash
playwright-cli -s=<sessionName> close
```

For parallel work, run Launch once per independent Agent task. Each invocation receives a unique CLI session backed by an isolated browser context and reads the same shared state. Never use `state-save` from a Launch session. If the Agent observes a login redirect, report it and ask whether to run Login.
