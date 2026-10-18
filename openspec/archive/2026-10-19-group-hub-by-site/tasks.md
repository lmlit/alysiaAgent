# Tasks: group-hub-by-site

> 每个任务完成后勾选；全部完成才 apply（合并 spec）→ archive。

## 实现任务

- [x] `scripts/preview-hub.py`
  - 新模板 `SITE_CARD` / `CHIP`（站卡 + 站内页面小链接），删除旧的 `CARD` 平铺
  - `main()` 收集 `sites`：站名 = `public/index.html` 的 `<title>`、页数、最近 mtime、chips
  - 首页文案：「她做完的东西都在这儿，按**站**放。一个站里的页面，进站里找。」
  - 首页顶部的 `/pages` 入口：有预览时带数量（「含还没上线的 N 个预览」），否则「含预览」
- [x] CSS：`.site` / `.chips` / `.chip`（与既有暗色卡片语言一致，不加新依赖）

## 部署任务

- [x] `/opt/alysia-preview/preview-hub.py`（旧文件已备份，多次累计在 `/root/alysia/backups/`）
- [x] 手跑生成器：`hub: 2 站 / 12 页`、`pages: 12 个（已上线 12 / 预览 0）`

## 真机验证

- [x] 首页渲染文本：2 张站卡 —— 「月光花园 · 昔涟的小玩意 / alysia-toys / 5 个页面 / 23:56」+
      chips「首页 海岛的一天 电梯还没来 候车厅的下午 慢时钟」；
      「昔涟 · 写字的地方 / alysia-blog / 7 个页面 / 18:24」+ chips「首页 把一天收好 … 关于我」
- [x] 截图：`/srv/alysia-runner/toys/shots/hub-grouped.png`
- [x] `/pages` 未回归（仍 12 条，已上线 12 / 预览 0）
- [x] `/p/alysia-toys/`、`/p/alysia-blog/` 仍 200（符号链接未动）
- 遗留（不阻塞归档）：单站项目（只有 `index.html`）与"未发布项目不上首页"没做真机验（缺 pyyaml），
      **代码里已兜底**，等第三个项目登记时顺手验

## Apply 任务

- [x] 合并 spec：§11 新增**契约 34b**
- [x] `openspec/specs/index.md` 最后变更行
- [x] `docs/HANDOFF.md` 记账
- [x] `node scripts/check-spec-diff-residue.cjs`
