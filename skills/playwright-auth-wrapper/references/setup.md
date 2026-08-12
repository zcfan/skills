# Setup

Use Setup when readiness reports `setupRequired: true`, or when the user explicitly asks to install Playwright, change the shared auth directory, or update locale, timezone, or Accept-Language.

## Defaults

Proceed automatically with these defaults unless the user supplied alternatives:

- Shared auth directory: OS user data location, normally `~/.local/share/playwright-auth/shared` on Linux/macOS and `%LOCALAPPDATA%\\playwright-auth\\shared` on Windows.
- Locale: `zh-CN`.
- Timezone: `Asia/Shanghai`.
- Accept-Language: `zh-CN,zh;q=0.9,en;q=0.8`.

## Run only the required stages

When `configuration.ready` is false, initialize it. Pass only user-supplied overrides; with no overrides the script uses the documented defaults:

```bash
node <skill-directory>/scripts/init_shared_auth.cjs --auth-dir <optional-dir>
```

If readiness reports an invalid existing JSON file rather than a missing file or path mismatch, stop and ask before replacing it. A corrupt `storage-state.json` may still be the user's only copy of a login and must not be reset automatically.

When `runtime.ready` is false, install the pinned private runtime and Chromium, then launch-test it:

```bash
node <skill-directory>/scripts/install_playwright_chromium.cjs --auth-dir <optional-dir>
```

Do not reinstall a ready runtime merely because configuration needed repair. The installer uses npm only inside the shared auth directory. Readiness requires the pinned private runtime in that directory; a project-local Playwright package does not satisfy user setup. If Chromium launch fails, use the script's JSON advice and reported missing library; do not assume every Linux distribution needs the same package.

Run the readiness check again and require `setupRequired: false`. Confirm that `storage-state.json`, `context-options.json`, and `metadata.json` exist with private permissions.

After Setup, continue to Login only if the original request explicitly asked for it. Otherwise ask whether the user wants to log in now; do not start a login browser before they agree.
