# Tasks: document-hub-dir-to-author（纯文档）

## 实现

- [x] `AGENTS.md`（两个项目各一份）新增 **「基站目录在哪（你能读，不能写）」**：
      - 目录树：`/srv/alysia-preview/{index.html, p/<项目> -> <工作区>/public}`
      - 生成器 `/opt/alysia-preview/preview-hub.py`，systemd timer **每 10 秒**跑
      - 「这些**都是 root 的**：你能读、能看，**不能写**（实测写 `index.html`、删/建 `p/` 链接都被拒）」
      - 「就算能写也**没意义**：每 10 秒按登记表重新生成，你的改动会被覆盖」
      - 「你不能改不是限制你，是**刻意的**：展示层必须稳，才能可靠地反映你做过什么」
      - 「想让基站换个样子 → **走正常渠道说**；这是可以给你开的口子（比如 `hub.css`），但要经过设计」
- [x] `.alysia-project.json` 增 `hubDir` / `hubGenerator` / `note`（机器可读）

## 验证（以 `alysia-runner` 身份）

- [x] 能读到新段落（`grep -n -A6 '基站目录在哪'` 命中）
- [x] 能读到元信息里的 `hubDir`
- [x] **边界没松**：`echo x >> index.html` ❌ / `touch p/x` ❌ / `rm -f p/alysia-toys` ❌ 全部拒绝

## 未做（已单独立项建议）

- [ ] 把她的契约做成**带占位符的仓库模板**（`{{HOST}}`/`{{PROJECT_ID}}`），部署时替换 ——
      现在 `AGENTS.md`/`publish.sh` 的源在 gitignored 目录里，**变更无法 review/回溯**
- [ ] 给基站开一个受限写口（只给 `hub.css`），让她能调门面但改不了"她做过什么"
