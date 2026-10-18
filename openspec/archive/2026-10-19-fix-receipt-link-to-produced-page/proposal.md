# Change Proposal: fix-receipt-link-to-produced-page

> 模板：复制到 `openspec/changes/<change-name>/proposal.md` 使用。
> 开发纪律见 `openspec/project.md`：任何行为变更必走 propose → apply → archive。

## 元信息

- **日期**: 2026-10-18
- **类型**: FIX（修 bug，补实现已声明的契约）
- **状态**: **archived（2026-10-19）**
- **影响 spec**: `project-tasks`（§10 契约 26 / §11 契约 38）

## 动机（为什么做）

**用户实测**（2026-10-18 23:04，QQ 私聊）：

> 她做完一个页面，回执里贴的地址是
> `http://<SERVER>:3389/p/alysia-toys/`，
> 我点开看到的是**「月光花园」**——她凌晨做的第一个小玩具，不是刚做的海岛。
> 我问她「这个链接不是你的月光花园的吗」，她答「那是上一轮的门牌号码」。

事实核对（线上只读）：

| 事实 | 值 |
|---|---|
| 回执地址来源 | `packages/server/src/webui/server.ts` 里 `projects[projectId].publicUrl`（**项目级**，恒定） |
| 该地址实际打开 | `/p/alysia-toys/` → `toys/public/index.html` = 月光花园（10-18 02:04） |
| 本轮产物 | `island.html`（85 KB，仍在写）；`public/` 里**没有**它 |
| 状态机终态 | `needs_review`（allowPublish=false ⇒ 停在 `ready`，**永不进 publish 阶段**） |

**这不是新需求**：`openspec/specs/project-tasks/spec.md` §11 **契约 38** 早已声明

> `projects.<id>.publicUrl = <base>/p/<id>/`。回执与推送带的是**她刚做的那个页面**，
> 不是基站根 —— 用户问"给我链接"时要一步到位。

⇒ 对账方向明确：**doc 已声明、impl 没接 ⇒ 改 impl，不改 doc**（把契约降级迁就现状 = 抹掉设计意图）。

## 需求（做什么）

- [ ] 回执 / QQ 推送里的地址 = **本轮产物页面的地址**（`/p/<id>/<文件>`），不是项目门牌
- [ ] 该页面**尚未发布**（不在 `public/`）时，给**只读预览地址** `/w/<id>/<文件>`，仍然点得开
- [ ] 没有任何本轮产物页时（只写了笔记/草图），回落项目门牌，且不冒充"这就是新页面"
- [ ] 服务端**只接受**由该项目 `publicUrl` 派生的地址（合法前缀校验），不接受任意串

## 设计决策（怎么做，含备选与取舍）

1. **谁来判定"本轮产物"**：**runner**（唯一能读宿主工作区的进程）。
   - 判据：工作区**根目录**的 `*.html`，`mtime ≥ 本轮开始`；最新优先。
   - 同时报告 `published`（`public/<同名>` 是否存在）——容器里的服务端看不到工作区，**它判不了**。
2. **谁拼地址**：runner 拼（它已从认领响应拿到 `publicUrl`），服务端只做**前缀校验**后采用。
   - 备选（否）：服务端读工作区 —— 容器看不见宿主路径，不可行。
   - 备选（否）：新增 `previewUrl` 配置 —— 要改 `loadConfig()` 逐字段映射（踩过 2 次"新配置段静默丢弃"），
     而 `/p/` ↔ `/w/` 是同一个基站的两个前缀，约定比配置更不容易漂。
3. **未发布页面怎么看**：基站新增 `/w/<id>/` 通道 → 符号链接到工作区根，**只读 + 扩展名白名单**
   （`.md`/`.json`/`.sh`/隐藏文件/`.tmp`/`.phases` 一律 404）。
   - 备选（否）：自动把产物复制进 `public/` —— 那等于**绕过 `allowPublish` 自己上线**，违反契约 62/72。
   - 备选（否）：把 `/p/<id>/` 改成"最新页重定向" —— 会破坏 `/p/<id>/` 作为项目门牌的语义（契约 33/36）。
4. **契约 38 的口径固定为**：地址必须指向**文件**；页面就是 `index.html` 时地址等于目录（`/p/<id>/`）。

## 对账方向确认

- [x] 与现有 spec 无冲突；gap 方向是 doc 已声明、impl 没接 ⇒ **改 impl**
- [x] 涉及 Web API？否（`/api/project-tasks/*` 的响应形状不变，`artifacts` 字段本就存在、此前恒为空）
- [x] 涉及她的文档（`AGENTS.md` / `.alysia-project.json`）？**是** —— 要补 `/w/` 预览通道一句
  （否则她会以为"没发布就没人看得见"）

## 测试计划

- 纯函数单测：`previewBase()`（`/p/` → `/w/`，非法形态回落）、`pickPageUrl()`（已发布/未发布/无产物/非法前缀）
- runner 单测：`artifactPages()`（只有本轮 mtime、忽略 `drafts/`、忽略非 html、最新优先、`index.html` 特判）
- 真机验收：
  1. `curl -s -o /dev/null -w '%{http_code}' <base>/w/alysia-toys/island.html` → 200
  2. `curl -s -o /dev/null -w '%{http_code}' <base>/w/alysia-toys/NOTES.md` → 404
  3. 造一个无副作用任务（`Reply with exactly: …`）走完整链路，检查日志里的「通知草稿」地址 = 产物页地址
  4. 回执正文地址与「她自己的话」里的地址一致（`finalizeNotice` 兜底仍在）
