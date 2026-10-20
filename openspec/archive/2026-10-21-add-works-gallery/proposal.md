# Proposal: add-works-gallery

## 元信息

- **日期**: 2026-10-21
- **类型**: FEATURE（新增 `works` collection 数据 + 博客栏目）
- **状态**: `applied`
- **影响 spec**: `ai-life-system` §18（作品栏目）
- **配套**：`blog/scripts/export-blog-data.py`、`sync-works.mjs`、`src/pages/works/index.astro`

## 要什么

把她**生成的页面**（基地站 `/p/<projectId>/` 下那些）在博客里做成一个「作品」栏目。
用户原话：「后续让昔涟生成的网站挂博客里」。

## 数据从哪来

**不是 DB，是 runner 工作区**：`/srv/alysia-runner/<项目>/public/`。
基站（`alysia-preview-hub`）每 10 秒扫这个目录并挂到 `/p/<projectId>/`。

导出（`export-blog-data.py` 里的 `read_works()`）：

| 步骤 | 做法 |
|---|---|
| 找项目 | 遍历 `/srv/alysia-runner/*/`，只认有 `public/` 的 |
| 项目 id | 读 `.alysia-project.json` 的 `projectId`（读不到用目录名） |
| 页面 | `public/` 下的 `*.html` |
| 标题/描述 | 从 html 的 `<title>` / `<meta name="description">` 取（取不到给空，不猜） |
| 更新时间 | 文件 mtime |

**排除 `alysia-blog`** —— 那是博客自己，写进"作品"会自我指涉。

## 三条约定

**契约 1：页面**不复制**进博客构建产物。**
博客只提供入口，链接直接指 `/p/<projectId>/<file>`。
复制会立刻产生两份副本，改一处忘另一处，最后没人知道哪个是真的。

**契约 2：导出里**不许出现服务器地址**。
`works.json` 只存 `projectId` 和文件名，URL 在页面里用相对路径拼。
仓库是公开的，写死 IP 会被 pre-commit 拦（也会泄露内网结构）。

**契约 3：没有作品时**必须**是合法状态**。
`works.json` 可以是空数组，页面显示"还没有作品。等她做出第一个。"
—— 不能因为"她还没做东西"让构建失败。

## 不做

- 不做作品详情页（页面本身在基站上，内容由她维护，博客不接管）
- 不做缩略图/截图（要额外截图链路，收益小于成本）
- 不做排序/筛选（目前只有几个页面，多了再说）

## 回滚

删 `src/pages/works/` + 导航里那一项 + `works.json`；`deploy.ps1` 里去掉 `sync-works` 调用。
