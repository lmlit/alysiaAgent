# Change Proposal: slim-docker-build-context

## 元信息

- **日期**: 2026-10-27
- **类型**: FIX（部署流水线）
- **状态**: applied（待归档）
- **来源**: 2026-10-27 首次带新决策发版时，`docker compose build` 卡在 “Building” **7 小时无进展**

## 问题

`packages/server/compose.yml` 的构建上下文是**仓库根**，而 `.dockerignore` 只排除了
`node_modules` / `docs` / `tests` 等，没排除本地素材与实验目录：

| 目录 | 大小 |
|---|---|
| `.video-demo` | 760.8 MB |
| `blog` | 537.6 MB |
| `.probe` | 475.2 MB |
| `.tmp` | 382 MB |
| `cyrene-assets` | 127.2 MB |
| `.tools` | 148.3 MB |

镜像真正需要的只有：根 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`、
`packages/core` 与 `packages/server` 的 `src` + `package.json` + `tsconfig.json`、
`packages/console/out`。上下文膨胀导致构建在传输阶段长时间无输出。

## 需求

- [x] `.dockerignore` 排除 `.video-demo` / `.probe` / `.tmp` / `.tools` / `blog` /
      `cyrene-assets` / Halo 主题 / dsh 包 / `packages/console` 的非 `out` 内容 /
      `packages/*/tests` / `packages/*/scripts`
- [x] 保留 `packages/console/out`（镜像 `COPY` 依赖它）
- [x] 重新构建验证：`docker compose build` 在数分钟内完成，镜像正常导出

## 明确不做

- 不改 Dockerfile 的分层策略（`pnpm install` 层仍需联网，本次未触发失效）。
- 不把 console 构建搬进镜像（既有决策：Next 构建需要外网字体，且慢）。
