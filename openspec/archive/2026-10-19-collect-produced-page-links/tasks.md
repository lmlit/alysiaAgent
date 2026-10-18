# Tasks: collect-produced-page-links

> 每个任务完成后勾选；全部完成才 apply（合并 spec）→ archive。

## 实现任务

- [x] `scripts/preview-hub.py`
  - 新增 `collect_workspace_pages()`：工作区**根目录**的 `*.html`（不递归 `drafts/`/`.tmp/`/`vendor/`）
  - 新增 `PAGES_HTML` / `PAGE_ROW` / `PAGES_CSS`（与基站同一套暗色卡片语言）
  - 基址从任一项目 `publicUrl` 反推（`…/p/<id>/` → `…`）；推不出就退化成相对路径
  - 产出 `pages.html`（原子写），基站首页加一行入口「全部页面（含还没上线的 N=…）」
  - 顺手把 `index.html` 的原子写抽成 `write_atomic()`（原来手写两行，现在两处共用）
- [x] 她的文档 `AGENTS.md`（toys + blog）：加「全部页面清单：`/pages`」一节（怎么用、不用维护）

## 部署任务

- [x] `/opt/alysia-preview/preview-hub.py`（旧文件备份到 `/root/alysia/backups/preview-hub.py.<ts>`）
- [x] 手动跑一次生成器：`hub: 11 page(s)` + `pages: 12 个（已上线 11 / 预览 1）`

## 真机验证

- [x] `/` → 200，且头部出现入口 `href="/pages"`「全部页面（含还没上线的 N=1）→」
- [x] `/pages` → **301** 到 `/pages.html`（`serve.py` 的无后缀回退），跟随 301 → **200 / 6.9 KB**
- [x] 内容抽查：第一条是「海岛的一天 · 预览 · alysia-toys · 23:26 + `/w/…/island.html`」，
      之后按时间倒序 11 条「已上线」，地址都是 `/p/<项目>/<文件>`
- [x] 截图（用她自己的 `shot.sh`）：`/srv/alysia-runner/toys/shots/pages-index.png`（1280×1600）
- [x] 回归：`/w/alysia-toys/island.html` 200、`/w/alysia-toys/NOTES.md` 404（白名单未受影响）

## Apply 任务

- [x] 合并 spec：§11 新增**契约 38d**
- [x] `openspec/specs/index.md` 最后变更行
- [x] `docs/HANDOFF.md` 记账
- [x] `node scripts/check-spec-diff-residue.cjs` → 0 行残留
- 遗留（不阻塞归档）：空工作区 / 无 `publicUrl` 两条例外路径没做真机验（生成器要 pyyaml），**代码里已兜底**，
      下次有第二个项目时可顺手验

## 追加（2026-10-19，用户认可后重写她那段说明书）

我第一版给她写的是「用户问'给我链接'——**先指 `/pages`**，再给具体地址」。用户问「给昔涟的
提示词，你觉得合适吗」，我说不合适，三条：

1. **方向反了**：契约 38 要"一步到位"，这句在教她拿目录代替那一页（正是她今晚两次说错链接的同一种病）；
2. **把陈列塞进她的自我认知**：她要的是"我记得我做过什么"（`get_project_task`），不是"我手上有个目录"；
3. **第三份重复 + 运维语气**：`/pages`、徽章、"每 10 秒自动重建"这些是给我们验收用的词。

已改为（toys + blog 两份 `AGENTS.md` 同步）：

```markdown
### 你的东西放在哪，和你该怎么给链接
`…/pages` 是**给人看的**总清单，你做的每页都在上面。你不用管它，它自己会更新。
**但别把它当成你回答"链接"的答案。** 用户说"给我看看"的时候：
- 手上有那一页的地址（回执，或 get_project_task 里的「页面地址」）⇒ 原样给他这一页；
- 只有他真的问"你都做过哪些""全部在哪看"，才给 /pages。
想知道自己做过什么…用 get_project_task 查那一轮。那个清单不是给你当记性用的。
```

- [x] 改前备份：`/root/alysia/backups/AGENTS.md.{toys,blog}.before-rewrite.<ts>`
- [x] 契约 38d 补一条警告：**`/pages` 不是"回答链接"的替代品**
- [x] 改的时候确认**没有在途任务**（`status='running'` 计数 0、无 `dsh --profile alysia` 进程）
      —— 这是契约 68c-补的教训（上次在轮次中间改，文档被搬走）
