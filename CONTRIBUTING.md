# Contributing

欢迎提交 Issue 和 Pull Request。这个仓库刻意保持简单：每个 skill 必须自包含，根目录只保留索引、校验和项目治理文件。

提交前请确认：

1. 没有加入登录态、token、cookie、认证截图、本机绝对路径或其他敏感数据。
2. skill 目录名与 `SKILL.md` 的 `name` 一致，触发描述清楚说明何时使用。
3. 修改 setup skill 中的 `shared_auth_common.cjs` 后，运行 `node scripts/sync-shared-auth-common.cjs` 同步另外两个副本。
4. 行为变化同时更新相关 `SKILL.md` 和测试。
5. 运行以下命令并确保通过：

```bash
node scripts/validate-skills.cjs
node --test
```

Pull Request 应只解决一个明确问题，并说明用户可见行为、安全影响和验证方式。
