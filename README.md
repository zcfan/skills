# Personal Skills

**English** | [简体中文](README.zh-CN.md)

My personal Codex and agent skills. Each `skills/<name>/` directory is an independently discoverable and runnable skill.

## Included Skills

- `playwright-auth-wrapper`: Reuses one manually established login state across multiple isolated Playwright automation instances running in parallel. It routes Setup, Login, and Launch based on the user's intent.
- `lark-worklog`: Records and tracks work progress in a structured Lark spreadsheet, with a same-day A:B read cache, task documents, and daily or monthly rollovers.

## Installation

General prerequisite: Node.js 18 or later. See the dedicated sections below for each skill's external dependencies.

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

It requires both the official [`@playwright/cli`](https://github.com/microsoft/playwright-cli) executable and the official `playwright-cli` companion Skill:

```bash
npm install -g @playwright/cli@latest
playwright-cli install --skills=agents
playwright-cli install-browser chromium
```

If either dependency is missing, `playwright-auth-wrapper` shows the official installation guide and recommends the applicable commands. It also asks whether the user wants the Agent to run those steps automatically; it never installs them without explicit approval. Reload the Agent if the newly installed companion Skill is not discovered immediately.

Its core purpose is to let you log in manually once, save that authentication state, and then launch multiple isolated `playwright-cli` sessions in parallel. Launch returns a unique session name and leaves the browser running. The Agent then follows the official `playwright-cli` Skill to navigate, interact, inspect, capture output, and eventually close that same session.

The skill starts with a read-only readiness check and routes requests in this order:

- Missing configuration or dependencies: run Setup, offering to install the official CLI, companion Skill, and Chromium when needed.
- Explicit login or expired-state refresh request: run Login. This is the only subflow allowed to write `storage-state.json`.
- Any other page opening, screenshot, or browser automation request: default to read-only Launch. The wrapper opens an authenticated named session and hands its name to the Agent without taking a screenshot or closing it. Each task receives an isolated session, so multiple tasks can safely read the same authentication state in parallel.

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

`lark-worklog` keeps a user-private same-day cache containing the selected workbook metadata and a normalized snapshot of columns A and B (task identity and today's entries). A clean cache can answer current-work read requests without loading Lark skills or making network calls. When no reusable target exists, the Skill uses the current authenticated Lark identity to find spreadsheets originally created by that user whose title contains the literal `[worklog]` marker:

```bash
lark-cli drive +search --query '[worklog]' --only-title \
  --doc-types sheet --created-by-me --page-size 20 --as user --format json
```

Results are filtered again to require the literal `[worklog]` substring. With one match, the skill uses it directly. With multiple matches, it selects the first API result and warns that stable behavior requires exactly one matching spreadsheet. With no match, it asks for authorization to create a new spreadsheet with the fixed title `工作日志 [worklog]`. If the user explicitly wants to use another spreadsheet, the skill validates its creator and structure before proceeding. A cache miss with valid target metadata reuses that exact workbook instead of searching again.

The cache is a read-only mirror: writes always use complete live cells, and every sheet mutation marks the cache dirty before writing. After remote read-back verification, the Skill reads the complete current A:B range and atomically replaces the cache. Failed or interrupted writes leave it dirty, so later reads must reconcile live state. Date changes and reported manual edits also force a live refresh. This contract assumes one machine running the Skill is the only routine spreadsheet writer; users can explicitly request a refresh after an occasional manual edit. Authentication and application settings remain managed by `lark-cli`.

On POSIX systems the cache directory uses mode `0700` and files use `0600`. It contains task titles and today's work items but no linked document bodies, historical columns, credentials, or timezone configuration. The default location is `~/Library/Caches/lark-worklog` on macOS and `${XDG_CACHE_HOME:-~/.cache}/lark-worklog` on Linux.

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
- Never commit work-log cache files, spreadsheet URLs, task content, or linked document tokens. The local cache is sensitive runtime data and must stay in its private cache directory.
- Store authentication data in the current user's data directory. On POSIX systems, directories use mode `0700` and sensitive files use `0600`.
- Install Playwright CLI and its companion Skill only after explicit approval, using the official project's instructions.
- Save state from the Login subflow only after the user confirms that manual login is complete. Validate a temporary export before atomically replacing existing state.
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
