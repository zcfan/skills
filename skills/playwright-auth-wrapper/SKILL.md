---
name: playwright-auth-wrapper
description: Reuse one manually established login state across multiple isolated playwright-cli sessions running in parallel, with routed Setup, Login, and Launch subflows. Requires the official @playwright/cli executable and its playwright-cli companion Skill. Use when a user asks to install or configure Playwright CLI, manually establish or refresh a site's shared login state, open or automate a site with persisted authentication, verify shared authentication, take authenticated screenshots, or run concurrent authenticated browser work. On first use, run Setup; prefer the read-only Launch subflow for normal automation.
---

# Playwright Auth Wrapper

Enable one manual login to serve multiple parallel Agent tasks. This Skill manages shared authentication and launches named sessions. The official `playwright-cli` Skill governs all browser interaction inside those sessions.

## Required dependency

Require both:

- the official `@playwright/cli` package, which provides `playwright-cli`;
- the official companion Skill installed by `playwright-cli install --skills=agents`.

Begin every request with the read-only dependency and readiness check:

```bash
node <skill-directory>/scripts/status_shared_auth.cjs
```

If either dependency is missing, show the user the official installation guide at <https://github.com/microsoft/playwright-cli> and recommend only the missing commands:

```bash
npm install -g @playwright/cli@latest
playwright-cli install --skills=agents
playwright-cli install-browser chromium
```

Then ask whether the user wants the Agent to run the official installation steps automatically. Do not install before they agree. After installation, read and follow the official `playwright-cli` Skill for browser commands. If the Agent does not discover the newly installed Skill immediately, ask the user to reload the Agent and then resume.

## Route the request

1. If configuration or dependencies are not ready, read [references/setup.md](references/setup.md).
2. Route explicit login, re-login, expired-session, or shared-state update requests to [references/login.md](references/login.md).
3. Route every other browser-opening, screenshot, verification, or automation request to [references/launch.md](references/launch.md). Launch is the normal path.

If the request is ambiguous and includes a target URL, choose Launch. A redirect to a login page is evidence to offer Login; it is not permission to overwrite shared state.

## Shared invariants

- Use the OS user data directory by default; honor `PLAYWRIGHT_SHARED_AUTH_DIR` or an explicit `--auth-dir` across all subflows.
- Login `save` is the only operation allowed to write `storage-state.json`.
- Launch creates a fresh named, isolated `playwright-cli` session that only reads the shared state.
- Return the session name to the Agent and leave the session running. The Agent decides the subsequent actions and when to close it.
- Reuse the same session name and working directory for every later `playwright-cli` command in that Agent task.
- Permit concurrent Launch sessions. Serialize Login saves with the state lock.
- Never commit, paste, or expose storage state, cookies, tokens, or authentication artifacts.
- Preserve configured locale, timezone, and headers unless the user explicitly changes them.
- Sanitize reported URLs by removing credentials, query parameters, and fragments.
- On POSIX systems, keep the auth directory at `0700` and state/config/metadata files at `0600`.
