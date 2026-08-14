# Setup

Use Setup when readiness reports missing configuration or a missing official Playwright CLI dependency.

## Install dependencies

The runtime dependency is the official `@playwright/cli` package. Browser operation depends on its official `playwright-cli` companion Skill. Use the installation instructions from <https://github.com/microsoft/playwright-cli>.

Tell the user what is missing, recommend the applicable commands below, and ask whether they want the Agent to run them automatically:

```bash
npm install -g @playwright/cli@latest
playwright-cli install --skills=agents
playwright-cli install-browser chromium
```

Do not install before the user agrees. Run `playwright-cli install --skills=agents` from the workspace where the Agent will automate the browser so the official Skill and CLI sessions use that workspace. Read that installed Skill before browser work. If it is not discoverable in the current Agent session, ask the user to reload the Agent and then resume.

## Initialize shared authentication

Initialize the private shared state only when `configuration.ready` is false. Pass only user-supplied overrides:

```bash
node <skill-directory>/scripts/init_shared_auth.cjs --auth-dir <optional-dir>
```

Defaults are locale `zh-CN`, timezone `Asia/Shanghai`, and Accept-Language `zh-CN,zh;q=0.9,en;q=0.8`.

If readiness reports invalid existing JSON, ask before replacing it because it may be the user's only saved login. Run the readiness check again after Setup. Continue to Login only when the original request asked to establish or refresh authentication; otherwise ask whether the user wants to log in now.
