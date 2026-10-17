# Tasks: add-preview-hub

> **状态（2026-10-18）**：T1–T5 完成，已部署并公网验证。

## 实现

- [x] **T1 生成器** `scripts/preview-hub.py`（python3 + pyyaml，root 跑）
      - 读 `config.yml` 的 `projects.*`；`<workspace>/public/index.html` 存在 ⇒ 视为已发布
      - 建 `p/<id>` 符号链接 → 生成卡片墙（标题取页面 `<title>`、时间取 mtime）
      - **原子替换**（`.tmp` + `os.replace`）；**幂等**（链接目标对就不动）；**会删**（未登记/未发布一律清掉）
- [x] **T2 systemd timer** `alysia-preview-hub.timer`（每 10s，`Type=oneshot`）
- [x] **T3 静态服务改 serve 基站根**：`WorkingDirectory=/srv/alysia-preview`（**不动容器/镜像**）
- [x] **T4 地址分两层**：`projects.<id>.publicUrl` → `/p/<id>/`（回执带**具体页面**，不是基站）
- [x] **T5 她的契约升级**：`.alysia-project.json` + `AGENTS.md` + `publish.sh`
      - `publish.sh` 现在从元信息文件读地址，四条判据里第 4 条改为"她的页面地址 200"，并打印基站与页面地址

## 真机验证

- [x] **幂等**：连跑两次，`index.html` md5 一致、链接集合稳定
- [x] **自动移除**：临时登记 `fake-proj`（指向 `/tmp/fake-project`）→ 卡片出现、链接存在；
      撤掉后 → 卡片 0、链接不存在；`config.yml` 复原并核对 `max_tokens` 仍是 4096
- [x] **公网**：`/` → `title=昔涟的基站` + 卡片「昔涟 · 关于我」+ `href=/p/alysia-blog/`；
      `/p/alysia-blog/` → 200/15265B；`/p/alysia-blog/style.css` → 200/15223B
- [x] **她的自检**：以 `alysia-runner` 跑 `./publish.sh` → 四条 ✅，打印
      「你的页面：…/p/alysia-blog/」「基站（总入口）：…/」
- [x] **回执**：新任务回执正文带 `http://…:3389/p/alysia-blog/`，推送恰好 1 条

## 未做

- [ ] 基站样式**不归她**（v1 统一卡片墙）；将来可允许她覆盖基站的 CSS
- [ ] 缩略图/截图（没有渲染链路）
- [ ] 基站的鉴权（与页面同姿态：无鉴权，明文 HTTP，仅靠安全组）
