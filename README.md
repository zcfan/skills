# Personal Skills

**English** | [简体中文](README.zh-CN.md)

My personal Codex and agent skills. Each `skills/<name>/` directory is an independently discoverable and runnable skill.

## Included Skills

- `playwright-auth-wrapper`: Reuses one manually established login state across multiple isolated Playwright automation instances running in parallel. It routes Setup, Login, and Launch based on the user's intent.
- `lark-worklog`: Records and tracks work progress by maintaining a structured Lark spreadsheet, including todos, progress updates, task documents, and daily or monthly rollovers.

## Installation

General prerequisite: Node.js 18 or later. The Playwright skill also requires npm. See the dedicated section below for the additional `lark-worklog` dependencies.

With an agent that supports [skills](https://skills.sh/):

```bash
npx skills@latest add zcfan/skills
```

The installer will ask which skill and target agent to use.

### Install Playwright Auth Wrapper

`playwright-auth-wrapper` provides Setup, Login, and Launch subflows:

```bash
npx skills@latest add zcfan/skills --skill playwright-auth-wrapper
```

Its core purpose is to let you log in manually once, save that authentication state, and then launch multiple isolated Playwright automation instances in parallel. Every instance reads the same saved state but uses its own Browser Context, so concurrent tasks do not share a writable browser profile or overwrite the login state.

The skill starts with a read-only readiness check and routes requests in this order:

- Not initialized: automatically run Setup to install the pinned Playwright version and Chromium, then ask whether to continue with Login.
- Explicit login or expired-state refresh request: run Login. This is the only subflow allowed to write `storage-state.json`.
- Any other page opening, screenshot, or browser automation request: default to read-only Launch. Each task creates an isolated Browser Context, so multiple tasks can safely read the same authentication state in parallel.

### Use Lark Worklog

`lark-worklog` records and tracks work progress by maintaining a structured Lark spreadsheet. It uses these four official skills from [LarkSuite CLI](https://github.com/larksuite/cli):

- `lark-shared`: Authentication, identity, permissions, and error handling.
- `lark-drive`: Title-based discovery of work-log spreadsheets created by the current authenticated user.
- `lark-sheets`: Workbook, worksheet, cell, rich-text, and style operations.
- `lark-doc`: Task-document creation, reading, and surgical updates.

If `lark-cli` or any required skill is missing, `lark-worklog` stops Lark operations and directs the user to the [official installation and quick-start guide](https://github.com/larksuite/cli#installation--quick-start). It also offers to follow the official guide and perform installation and verification automatically, but never runs the installer without explicit approval. The recommended command is:

```bash
npx @larksuite/cli@latest install
```

Reload the agent after installation so it can discover the official skills.

`lark-worklog` stores no local configuration. On the first work-log request in each conversation, it uses the current authenticated Lark identity to find spreadsheets originally created by that user whose title contains the literal `[worklog]` marker:

```bash
lark-cli drive +search --query '[worklog]' --only-title \
  --doc-types sheet --created-by-me --page-size 20 --as user --format json
```

Results are filtered again to require the literal `[worklog]` substring. With one match, the skill uses it directly. With multiple matches, it selects the first API result and warns that stable behavior requires exactly one matching spreadsheet. With no match, it asks for authorization to create a new spreadsheet with the fixed title `工作日志 [worklog]`. If the user explicitly wants to use another spreadsheet, the skill validates its creator and structure before proceeding. Later work-log requests in the same conversation reuse the selected spreadsheet without searching again unless the user explicitly asks to switch or rediscover the target.

The skill never writes spreadsheet URLs, timezones, document tokens, or search results to local storage. Workbook selection is reused only within the current conversation, and work-log dates use the agent process's local clock. Daily rollover inserts today's column before column B and verifies the resulting structure. When automatic daily or monthly rollover is required, the agent first explains that structural changes and read-back verification may make the request slightly slower, then continues. Authentication and application settings remain managed by `lark-cli`.

For repository development on macOS or Linux, link every skill into the agent's skill directory:

```bash
skills_dir="${AGENT_SKILLS_DIR:-$HOME/.agents/skills}"
mkdir -p "$skills_dir"
for skill_dir in skills/*; do
  ln -sfn "$(pwd)/$skill_dir" "$skills_dir/$(basename "$skill_dir")"
done
```

## Repository Layout

```text
skills/
└── <skill-name>/
    ├── SKILL.md            # Required: triggers and core workflow
    ├── agents/openai.yaml  # Recommended: UI metadata
    ├── scripts/            # Optional: deterministic helpers
    ├── references/         # Optional: detailed, on-demand instructions
    └── assets/             # Optional: reusable output assets
```

- Use lowercase kebab-case for skill directory names and match the `name` in `SKILL.md`.
- Keep triggers, the core workflow, and essential constraints in `SKILL.md`; place detailed instructions in `references/`.
- Keep every skill self-contained. Do not use symlinks or relative paths to depend on another repository skill. Declare external binaries and official skill dependencies in both `SKILL.md` and this README.

## Security Model

- Never commit login state, tokens, cookies, authentication screenshots, or runtime configuration.
- Never commit work-log spreadsheet URLs, task content, or linked document tokens. `lark-worklog` creates no local configuration.
- Store authentication data in the current user's data directory. On POSIX systems, directories use mode `0700` and sensitive files use `0600`.
- Install the pinned Playwright runtime privately inside the authentication directory without modifying the global npm environment.
- Save state from the Login subflow only after the user creates the session-specific confirmation marker. A timeout never overwrites existing state.
- Remove credentials, query parameters, and fragments from URLs in logs and metadata.

Report security issues privately through [SECURITY.md](SECURITY.md).

## Development and Validation

```bash
node scripts/validate-skills.cjs
node --test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

[MIT](LICENSE)
