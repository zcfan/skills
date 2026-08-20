# Personal Skills

[English](README.md) | **简体中文**

我的个人 Codex / agent skills。每个 `skills/<name>/` 目录都是一个可独立识别和运行的 skill。

## 当前 skills

- `playwright-auth-wrapper`：让多个相互隔离的 Playwright 自动化实例并行运行，并复用同一份由用户手动完成的登录态；同时按用户意图路由 Setup、Login 和 Launch 子流程。
- `lark-worklog`：通过维护结构化飞书表格来记录并跟踪工作进度，支持当日 A、B 两列只读缓存、任务文档以及跨日和跨月滚动。

## 安装

通用前置要求：Node.js 18 或更高版本。每个 Skill 的外部依赖见下方对应专节。

使用支持 [skills](https://skills.sh/) 的 agent：

```bash
npx skills@latest add zcfan/skills
```

安装器会让你选择需要的 skill 和目标 agent。

### 安装 Playwright Auth Wrapper

`playwright-auth-wrapper` 提供 Setup、Login 和 Launch 三个子流程：

```bash
npx skills@latest add zcfan/skills --skill playwright-auth-wrapper
```

它同时依赖官方 [`@playwright/cli`](https://github.com/microsoft/playwright-cli) 命令和该 CLI 配套的官方 `playwright-cli` Skill：

```bash
npm install -g @playwright/cli@latest
playwright-cli install --skills=agents
playwright-cli install-browser chromium
```

如果缺少任一依赖，`playwright-auth-wrapper` 会提供官方安装说明和适用的推荐命令，并询问是否需要 Agent 自动执行这些步骤；未获得明确同意前不会安装。如果新安装的配套 Skill 没有被立即发现，应重新加载 Agent。

它的核心作用是：只需手动登录一次并保存登录态，之后即可并行启动多个相互隔离的 `playwright-cli` 会话。Launch 会返回唯一的会话名并保持浏览器运行；Agent 随后按照官方 `playwright-cli` Skill，在同一会话中完成导航、交互、检查、结果采集以及最终关闭。

它会先执行只读状态检查，并按以下优先级选择子流程：

- 配置或依赖缺失：运行 Setup，并在必要时提议安装官方 CLI、配套 Skill 和 Chromium。
- 明确要求登录或刷新过期状态：运行 Login。只有该子流程能够写入 `storage-state.json`。
- 其他打开网页、截图和自动化请求：默认运行只读 Launch。Wrapper 只打开带登录态的具名会话并把会话名交给 Agent，不自动截图或关闭。每个任务获得独立会话，可并行读取同一登录态。

### 使用飞书工作日志

`lark-worklog` 通过维护结构化飞书表格来记录并跟踪工作进度。它使用飞书官方 [LarkSuite CLI](https://github.com/larksuite/cli) 提供的以下四个 Skills：

- `lark-shared`：认证、身份、权限和错误处理。
- `lark-drive`：按标题搜索当前登录用户创建的工作日志表格。
- `lark-sheets`：工作簿、工作表、单元格、富文本和样式操作。
- `lark-doc`：任务文档的创建、读取和局部更新。

缺少 `lark-cli` 或其中任何一个 Skill 时，`lark-worklog` 会停止飞书操作并引导用户按照[官方安装与快速开始说明](https://github.com/larksuite/cli#installation--quick-start)安装。它还会主动询问用户是否需要 Agent 按官方文档自动完成安装与验证；获得明确同意前不会运行安装器。官方推荐命令是：

```bash
npx @larksuite/cli@latest install
```

安装后应重新加载 agent，使官方 Skills 可被发现。

`lark-worklog` 会在当前用户的私有缓存目录中保存一份当日缓存，其中只包含已选工作簿的元数据，以及 A、B 两列（任务身份和今日记录）的规范化快照。缓存干净且日期为今天时，读取当前事项无需加载飞书 Skills 或发起网络请求。没有可复用目标时，Skill 才使用当前登录的飞书用户身份搜索由该用户创建、且标题包含字面量 `[worklog]` 的电子表格：

```bash
lark-cli drive +search --query '[worklog]' --only-title \
  --doc-types sheet --created-by-me --page-size 20 --as user --format json
```

搜索结果还会按标题是否真正包含 `[worklog]` 做精确过滤。只有一个结果时直接使用；有多个结果时按搜索返回顺序使用第一个，同时提醒用户必须保证只有一个匹配表格，才能获得稳定效果；没有结果时会请求授权，以当前用户身份创建标题固定为 `工作日志 [worklog]` 的新表。如果用户明确要求使用另一张表，Skill 会先校验其创建者和结构。缓存未命中但仍带有有效目标元数据时，会复用同一本工作簿，不再重复搜索。

缓存只是只读镜像：所有写入都基于完整的线上单元格读取；每次修改表格前先把缓存标记为 dirty，线上写入和回读验证成功后，再完整读取当前 A、B 两列并原子替换缓存。写入失败或中断时缓存保持 dirty，后续读取必须先与线上状态对账。跨日以及用户声明刚刚手工修改过表格时，也会强制刷新。本契约假设一台机器上的 Skill 是日常唯一写入者；偶尔手工修改后，用户可以显式要求刷新。认证和应用配置仍由 `lark-cli` 管理。

在 POSIX 系统上，缓存目录权限为 `0700`，文件权限为 `0600`。缓存包含任务标题和今日事项，但不包含关联文档正文、历史日期列、凭证或时区配置。macOS 默认路径为 `~/Library/Caches/lark-worklog`，Linux 默认路径为 `${XDG_CACHE_HOME:-~/.cache}/lark-worklog`。

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
- 每个 skill 的仓库内资源必须自包含，不得通过符号链接或相对路径依赖其他 skill；外部二进制或官方 Skills 依赖必须在 `SKILL.md` 和本 README 中明确声明。

## 安全模型

- 登录态、token、cookie、认证截图和运行时配置均不得提交到仓库。
- 工作日志缓存文件、表格链接、任务内容和关联文档 token 不得提交到仓库；本地缓存属于敏感运行时数据，只能保留在私有缓存目录中。
- 默认认证目录在当前用户的数据目录中；POSIX 系统上目录权限为 `0700`，敏感文件为 `0600`。
- 只有获得明确授权后，才按照官方项目说明安装 Playwright CLI 及其配套 Skill。
- Login 子流程只在用户确认手动登录完成后保存状态；先校验临时导出的状态，再原子替换已有状态。
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
