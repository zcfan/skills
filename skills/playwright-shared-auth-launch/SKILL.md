---
name: playwright-shared-auth-launch
description: Launch new Playwright Browser Contexts from shared context-options and storageState without modifying persisted login state. Use when a user asks to open one or more sites with shared login, run browser automation using persisted auth, verify storageState reuse, take screenshots, or run multiple independent Playwright contexts in parallel.
---

# Playwright Shared Auth Launch

Use this skill for read-only reuse of the shared browser login state. It must not write `storage-state.json`.

Each automation task should create its own Browser Context from shared context options. This supports parallel execution without sharing a persistent profile directory.

## Script

Open a URL and screenshot it:

```bash
node <skill-directory>/scripts/open_with_shared_state.cjs <url>
```

Options:

- `--auth-dir <dir>`: read a non-default shared auth directory.
- `--screenshot <path>`: choose the screenshot path; the default uses the OS temporary directory.
- `--wait-ms <ms>`: wait after navigation before screenshot.

The script reports:

- requested URL
- final URL
- page title
- screenshot path
- `navigator.language`
- whether it appears redirected to login

## Parallel Pattern

For multiple URLs, run one Browser Context per URL. It is safe for many contexts to read the same `storage-state.json` concurrently. Do not write state from these contexts. Use `$playwright-shared-auth-login` when storage state must be updated.

The script loads the pinned Playwright version installed by setup in the private shared-auth runtime. It falls back to a local project installation only for development.

Default screenshots are created in a private temporary directory. On POSIX systems, the directory is mode `0700` and the screenshot is `0600`. Reported URLs omit credentials, query parameters, and fragments.
