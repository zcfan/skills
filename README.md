# Personal skills

我的个人 Codex / agent skills。每个 `skills/<name>/` 目录都是一个可独立识别和运行的 skill；强关联的 skills 会在 README 中定义为一个需要共同安装和更新的 **Skill 组**。

## 当前 skills

### `playwright-shared-auth` Skill 组

- `playwright-shared-auth-setup`：初始化共享认证配置，安装固定版本的 Playwright 与 Chromium。
- `playwright-shared-auth-login`：通过人工确认写入共享 Playwright 登录态。
- `playwright-shared-auth-launch`：只读复用共享登录态打开页面。

这三个 skills 共同构成一套完整的 Playwright 共享认证工作流，一般应当全部安装：`setup` 负责一次性初始化，`login` 负责写入或更新登录态，`launch` 负责日常只读复用。三者将浏览器上下文参数和 `storageState` 放在同一个私有数据目录中，但不会共享持久化浏览器 profile。普通自动化可并行读取状态，只有 login skill 可以串行写入。

### 独立 Skill

- `lark-worklog`：使用官方 `lark-cli` 将零散待办、进展、任务文档和跨日/月滚动维护到结构化飞书工作日志中。

## 安装

通用前置要求：Node.js 18 或更高版本。Playwright skills 还需要 npm；`lark-worklog` 需要已安装并登录的官方 [飞书 CLI](https://www.feishu.cn/feishu-cli)（`lark-cli`）。

使用支持 [skills](https://skills.sh/) 的 agent：

```bash
npx skills@latest add zcfan/skills
```

安装器会让你选择需要的 skill 和目标 agent。

### 安装 Playwright Skill 组

[Agent Skills 规范](https://agentskills.io/specification)和当前的 [`skills` CLI](https://github.com/vercel-labs/skills#readme) 尚未提供由仓库作者声明 skill 依赖或命名组的正式机制；社区中的 [Skill 组提案](https://github.com/vercel-labs/skills/issues/992)仍在讨论中。因此，本仓库使用文档层的 Skill 组约定：三个目录仍是独立 skills，但安装和更新时应视为一个整体。

使用一条命令精确安装整个组，避免同时安装仓库中不相关的 skills：

```bash
npx skills@latest add zcfan/skills \
  --skill playwright-shared-auth-setup \
  --skill playwright-shared-auth-login \
  --skill playwright-shared-auth-launch
```

使用交互式安装器时，请同时选择这三个 skills。更新时也应同时更新整个组：

```bash
npx skills@latest update \
  playwright-shared-auth-setup \
  playwright-shared-auth-login \
  playwright-shared-auth-launch
```

首次使用浏览器认证前，先运行 `playwright-shared-auth-setup`。

### 配置飞书工作日志

首次使用 `lark-worklog` 时，提供现有工作日志链接，或明确授权创建一张新表。默认表格链接只保存在当前用户的私有配置目录中，不会写入本仓库：

```bash
node <skill-directory>/scripts/worklog.cjs configure --url <飞书表格或知识库链接> --timezone Asia/Shanghai
```

开发本仓库时，也可以在 macOS/Linux 上把 skills 链接到 agent 的 skills 目录：

```bash
skills_dir="${AGENT_SKILLS_DIR:-$HOME/.agents/skills}"
mkdir -p "$skills_dir"
for skill_dir in skills/*; do
  ln -sfn "$(pwd)/$skill_dir" "$skills_dir/$(basename "$skill_dir")"
done
```

## 目录约定

```text
skills/
└── <skill-name>/
    ├── SKILL.md            # 必需：触发条件和工作流
    ├── agents/openai.yaml  # 推荐：界面展示信息
    ├── scripts/            # 可选：确定性脚本
    ├── references/         # 可选：按需加载的详细资料
    └── assets/             # 可选：生成输出时使用的资源
```

- skill 目录名使用小写 kebab-case，并与 `SKILL.md` 的 `name` 一致。
- `SKILL.md` 只保留触发条件、核心流程和必要约束；详细资料放到 `references/`。
- 每个 skill 必须自包含，不得通过符号链接或相对路径依赖其他 skill。
- Skill 组是 README 中声明的安装与更新约定，不是额外的 skill，也不改变各成员的触发边界。
- Playwright Skill 组内的 `shared_auth_common.cjs` 是刻意保留的相同副本，以满足独立安装要求；仓库校验会防止它们意外分叉。

## 安全模型

- 登录态、token、cookie、认证截图和运行时配置均不得提交到仓库。
- 工作日志表格链接、任务内容、关联文档 token 和 `lark-worklog` 本机配置不得提交到仓库。
- 默认认证目录在当前用户的数据目录中；POSIX 系统上目录权限为 `0700`，敏感文件为 `0600`。
- Playwright 固定安装在认证目录下的私有 runtime 中，不修改全局 npm 环境。
- login skill 只在用户为当前会话创建随机确认标记后保存状态；超时不会覆盖现有状态。
- 日志和 metadata 中的 URL 会移除凭证、查询参数与 fragment。

安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告。

## 开发与校验

```bash
node scripts/validate-skills.cjs
node --test
```

贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
