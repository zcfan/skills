---
name: playwright-auth-wrapper
description: Reuse one manually established Playwright login state across multiple isolated automation instances running in parallel, with routed Setup, Login, and Launch subflows. Use when a user asks to install or configure Playwright Chromium, manually establish or refresh a site's shared login state, open or automate a site with persisted authentication, verify shared authentication, take authenticated screenshots, or run concurrent authenticated browser work. On first use, automatically run Setup; prefer the read-only Launch subflow for normal daily automation.
---

# Playwright Auth Wrapper

Enable one manual login to serve multiple parallel automation tasks. Every Launch reads the same saved authentication state into a fresh, isolated Browser Context and never writes that shared state.

Select the appropriate subflow while preserving strict state ownership:

- **Setup** creates configuration and installs the pinned private Playwright runtime.
- **Login** is the only subflow allowed to write `storage-state.json`.
- **Launch** is the default and never writes shared authentication state.

## Route the request

1. Run the read-only readiness check:

   ```bash
   node <skill-directory>/scripts/status_shared_auth.cjs
   ```

2. If `setupRequired` is true, read [references/setup.md](references/setup.md) and run only the required Setup stages automatically before any other subflow. Tell the user that first-time runtime installation may take a few minutes because it downloads and launch-tests Chromium.
3. After automatic Setup:
   - Continue directly to Login only when the user's original request explicitly asked to log in, add a login, or refresh expired authentication.
   - Otherwise stop and ask whether they want to log in now. If no target URL is known, ask for it only after they say yes.
4. If setup is ready, route explicit installation or context-option changes to [references/setup.md](references/setup.md).
5. Route explicit login, re-login, expired-session, or shared-state update requests to [references/login.md](references/login.md).
6. Route every other browser-opening, screenshot, verification, or automation request to [references/launch.md](references/launch.md). Launch is the normal daily path.

If the intent is ambiguous but a target URL is available, choose Launch. A redirect to a login page is evidence to offer Login; it is not permission to write shared state automatically.

## Shared invariants

- Use the OS user data directory by default; honor `PLAYWRIGHT_SHARED_AUTH_DIR` or an explicit `--auth-dir` consistently across all subflows.
- Keep one private Playwright runtime and one shared state directory, but create a fresh Browser Context for each automation task.
- Permit concurrent Launch readers. Serialize Login writers with the state lock.
- Never commit, paste, or expose `storage-state.json`, cookies, tokens, confirmation markers, or authentication screenshots.
- Preserve configured locale, timezone, and headers unless the user explicitly asks to change them.
- Sanitize reported URLs by removing credentials, query parameters, and fragments.
- On POSIX systems, keep the auth directory at `0700` and state/config/metadata/screenshots at `0600`.
- Do not treat a timeout as successful login. Leave existing state unchanged and report that nothing was saved.
