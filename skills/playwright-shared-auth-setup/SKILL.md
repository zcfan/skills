---
name: playwright-shared-auth-setup
description: Initialize shared Playwright authentication configuration and install a pinned Playwright runtime and Chromium with cross-platform scripts. Use when a user asks to set up Playwright, install Playwright-managed Chromium, choose or change the shared storageState/config directory, set default locale/timezone/Accept-Language, or verify browser dependencies before using shared login state.
---

# Playwright Shared Auth Setup

Use this skill only for setup. It creates the shared auth directory and context options, installs Playwright and Chromium, and verifies Chromium can launch.

Ask the user before changing defaults when the request is ambiguous:

- Shared auth directory default: OS user data location, usually `~/.local/share/playwright-auth/shared` on Linux/macOS and `%LOCALAPPDATA%\\playwright-auth\\shared` on Windows.
- Locale default: `zh-CN`.
- Timezone default: `Asia/Shanghai`.
- Accept-Language default: `zh-CN,zh;q=0.9,en;q=0.8`.

Prefer scripts over rewriting commands.

## Scripts

Initialize or update shared config:

```bash
node <skill-directory>/scripts/init_shared_auth.cjs --auth-dir <optional-dir> --locale zh-CN --timezone Asia/Shanghai --accept-language 'zh-CN,zh;q=0.9,en;q=0.8'
```

Install Playwright and Chromium, then launch-test Chromium:

```bash
node <skill-directory>/scripts/install_playwright_chromium.cjs --auth-dir <optional-dir>
```

The installer creates a private npm runtime under the shared auth directory, installs the pinned Playwright version declared by the skill, invokes that exact package's CLI to install Chromium, and uses the same module for its launch test. A project-local module is only a development fallback. If Chromium launch fails, read the script's JSON advice and install the missing system dependency for the current OS. Do not assume every Linux machine needs the same package; inspect the reported missing library.

## Output

Confirm these files exist after setup:

- `storage-state.json`
- `context-options.json`
- `metadata.json`

Do not store secrets in a repo. Treat `storage-state.json` as sensitive.
On POSIX systems, confirm the auth directory is mode `0700` and its JSON files are `0600`.
