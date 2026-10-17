# Tasks: isolate-delegated-task-memory

> **状态（2026-10-17）**：T1–T5 完成；**T6（真机验收）未执行** —— 它需要先把服务端改动
> **部署**到线上（docker 换镜像 + 重启容器），属生产操作，**未擅自执行**。
> T7 是我本轮探测留下的痕迹，等用户决定删还是留。

## 实现任务

### T1 — adapter：上报会话来源事实 ✅

- [x] `session-id.ts` 加 `DSH_ORIGIN_FIELD = 'dsh_origin'`（跨包契约，与 server 侧字面量一致）
- [x] `Config.sessionOrigin?: string`；`apply()` 里 trim 后传给 `installBridge`
- [x] `push()` 在非空时带 `payload.dsh_origin`；**缺省一个字段都不多**（反向守卫有测试）
- [x] 挂载时打一行「会话来源标记已启用」（装没装上必须可观测）

### T2 — adapter：委托会话不结算 ✅

- [x] `session/disposed` 时若配了 `sessionOrigin` ⇒ **只排空、不 `extractSession`**
      （理由：它的内容按定义不进记忆，结算只会白烧一次 LLM + 造空摘要行）
- [x] 事件**照常回传**（审计轨迹要留）
- [x] 反向守卫：没配 ⇒ 仍然结算（桌面端行为一字不变）

### T3 — server：判定（复用既有闸）✅

- [x] `DSH_ORIGIN_FIELD` 常量 + `validateIngestEvent` 校验（出现必须是非空字符串，否则**拒收**）
- [x] `normalizeIngestEvent`：非空 ⇒ `skip_profile = true` + `synthetic = <值>`
- [x] 与 `dsh_source` 正交；同时命中时 `synthetic` 取更精确的**消息级**原因

### T4 — core：留痕文案原因中立 ✅

- [x] `RealtimeProcessor` 的跳过年志由「合成注入」改为「非用户发言（原因）」
      （`synthetic` 现在也承载委托会话，旧措辞会把排查带偏）
- [x] 更新既有断言（口径变严：必须能看到「为什么被跳过」）
- [x] 新增：委托会话标记与合成注入**一视同仁**（同闸、同后果）

### T5 — 服务器：委托 profile 配上标记 ✅（**需部署服务端才生效**）

- [x] `alysia` profile 的 adapter 行加 `sessionOrigin: delegated-task`
- [x] 重打包（含 T1–T2）→ 上传 → `dsh plugin --profile alysia add` → `--dump-config` 核对
- [x] 确认未触碰 `web`/`headless` profile、未重启任何服务
      （`web` 进程 etime 未变）
- [x] ⚠️ 在 profile patch 里写明：**旧服务端会静默忽略这个标记**

### T6 — 真机验收 ✅（服务端已部署）

- [x] 构建并部署服务端镜像（**只换镜像**，未上传 config/compose）——
      回滚锚点 `server-alysia:rollback-20261017`；证据见 [`e2e-evidence.md`](e2e-evidence.md)
- [x] 跑两轮委托任务（第二轮 `--session-id` 续作）→ 查库：**6 条事件全部**带
      `skip_profile=True` / `synthetic=delegated-task` / `dsh_origin=delegated-task`
- [x] 确认**没有**产出 conversations 行
- [x] 回归：历史 dsh 事件抽样 200 条**全部无标记**（正常会话未被误伤）
- [ ] ⚠️ **未验**：「跳过结算」分支在本次运行里**没被执行到**（headless 下 `session/disposed`
      疑似未触发）—— 该分支只有单测覆盖，**不得**用「摘要行=0」当它的证据（见证据 §3）

### T7 — 数据：本轮探测在生产库留下的痕迹 ⏳（待用户决定）

- [ ] 生产库有 **9 条**未标记的探测事件（3 个 `dsh:session-*`，见 e01-evidence §1 的对照查询）
- [ ] 选项 A：删除（含其向量，同 KI-20 的做法：先备份、`VACUUM INTO`、只删不猜）
- [ ] 选项 B：保留（它们是审计轨迹，且已确认是探测内容）
- [ ] 无论哪种：**不改**任何真实用户数据

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/dsh-adapter/spec.md`（新增 §2.5.2）
- [ ] 更新 `openspec/specs/index.md`
- [ ] 全仓测试
- [ ] 跑 `scripts/check-spec-diff-residue.cjs`
