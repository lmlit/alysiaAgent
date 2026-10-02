# scripts/git-hooks

`pre-commit` —— 敏感信息扫描。**本仓是 PUBLIC 仓库**，同类事故已发生两次
（8-09 `git add -A` 把内部 SOP 带进去；8-28 密码明文进 `sync-from-server.sh` 暴露 28 天），
两次都是人工审查漏的 —— 交给机器。

## 安装（每个 clone 各做一次，这是本地 git 配置、不随仓库走）

```sh
git config core.hooksPath scripts/git-hooks
```

## 扫什么

只扫**新增行**（含新增文件全文），不回头扫存量：

1. **通用模式**（写在 `pre-commit` 里）：私钥头、`sk-` / `ghp_` / `AKIA` 等密钥前缀、
   赋值型（`password|secret|api_key|SUDO_PASS|… = <12+ 字面量>`）。
   值必须是"像密钥的东西"（不含点/美元/引号）⇒ 天然放过 `${VAR}`、`process.env.X`、`config.server.x`
2. **本地模式**：`<repo>/.git/alysia-secret-patterns`，一行一条 grep -E 模式。
   **具体值写这里，不写本目录** —— 本目录会进公开仓库，而 `.git/` 内的文件永不被跟踪。
   服务器地址、SSH 账号、bot appid 这类"不该公开且不该写进公开脚本"的词放这。

## 误报

`git commit --no-verify` 跳过 —— 跳过前请真的看一眼那行。
