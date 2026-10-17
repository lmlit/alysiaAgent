# Spec delta: connect-server-dsh-bridge

> 目标 spec：`openspec/specs/dsh-adapter/spec.md`
> 本文件是**变更增量**（不是整份 spec 的副本）。apply 时按下面的定位合并进主 spec，
> 合并后运行 `scripts/check-spec-diff-residue.cjs`（残留 `^+` 即拒绝归档）。
>
> 合并定位：
> 1. **新增 §2.7**（放在 §2.6 Agent preset 之后）
> 2. **§2.2 追加一段**（记忆读通道的鉴权要求）
> 3. **§4 销账表**新增一行（服务器侧运行体）

---

## +§2.7 服务器侧运行体（委托任务的第一段落地）

> ★ 2026-10-17（change: `connect-server-dsh-bridge`）。
> 背景与实测证据：`docs/ALYSIA-DSH-BRIDGE-SERVER-INVENTORY.md`（只读 SSH 盘点）、
> `docs/ALYSIA-DSH-BRIDGE-PROBE-2026-10-17.md`（CLI 实测）。

### +2.7.1 形态：独立 profile + `headless`，不复用运行中的 `web`

- 委托任务跑在**新建的独立 profile**（`alysia`）上，组合 = `@deepseek-ai/dsh-base`
  + `@deepseek-ai/dsh-headless` + `@alysia/dsh-adapter`。
- **契约**：不得把 adapter 加进正在提供服务的 profile。
  理由：那是用户正在用的生产界面（服务器上是 `:3080` 的 `web` profile），
  混入委托会话会同时污染**用户体验**与**来源可判定性**（两者都在同一进程里，事后分不开）。
- 运行体形态选 `headless`：**一次性进程**，建会话 → 提交 → 等静默 → 打印结果 → 退出，
  **不监听端口**；`--session-id` 可续作同一会话；`--json` 输出机器可读事件流
  （首行含 `sessionId` 与 `cwd`；`status.phase` 给状态；`turn_end.reason` 给终态）。
- ⚠️ **契约**：`headless`/SDK 路径**没有 agent preset 名册**（名册只在 web-app 组合包里）。
  所以「使用 Alysia 模式」在委托运行体上**不是选一个 preset id**，而是
  **把相同的人设变量 + adapter 插件行挂进该 profile**。任何依赖「按会话指定 preset」的设计都不成立。

### +2.7.2 鉴权：桥接必须携带 alysia 的 WebUI token

- **现象（服务器实测）**：容器内绑 `0.0.0.0` ⇒ `needsAuth` 为真 ⇒
  `/api/*` 强制 `Authorization: Bearer <token>`（仅 `/api/health` 豁免）。
  而 `AlysiaClient` 原实现**不带任何鉴权头** ⇒ 所有桥接调用 401。
- **契约**：`AlysiaClient` **必须**支持 Bearer token；缺省从环境变量
  `ALYSIA_WEBUI_TOKEN` 取，插件 config 的 `alysiaToken` 显式值优先。
  未配置 token 时**照旧按 best-effort 失败**（不回退到无鉴权，也不静默通过）。
- **契约**：token **只经环境变量/config 传递**，源码与仓库内**不得出现字面量**。
- ⚠️ **部署地址不是对称的**：桥接的 `alysiaBaseUrl` 必须是**宿主机能看到**的地址。
  服务器上 alysia 容器映射为 `127.0.0.1:6186`（`6185` 是**容器内**端口）；
  桌面端本机跑 alysia 时才是 `127.0.0.1:6185`。**照抄另一端会连不通。**

### +2.7.3 分发：本地打包 → 上传 → profile 内安装

- **契约**：服务器**不能连 GitHub**，本包**未发布 npm** ⇒ 必须
  `npm pack` → 上传 → `dsh plugin --profile alysia add <tarball>`。
- **契约**：打包**必须**在 `dist/` 重建之后。实测教训：
  桌面端正在加载的 `dist/` 停在 2026-10-02，**不含** KI-23/KI-24 与失败分类的修复
  —— 「源码已修」不等于「分发物已修」，把旧 dist 打包出去等于把缺陷一起搬运。

### +2.7.4 日志：委托运行体必须自备 exporter，且**只能写 stderr**

- **现象（实测 + 源码核实）**：cordis 的 `LoggerService` 启动时**只注册一个内存环形缓冲 exporter**
  （`bufferSize = 1000`，只入数组、从不打印）；真正打印的是独立插件
  `@deepseek-ai/cordis-plugin-logger-console`（行 id `logger-console`），
  而 dsh 的 **base / headless / web-app 三个组合包都不含这一行**。
  ⇒ 在这三种组合里，**任何插件**的 `ctx.logger.*` 都进内存就没人看。
- **契约**：委托运行体的组合**必须**显式挂一个 exporter，否则「桥接到底通没通」不可观测
  （表现为「什么都没有发生」，而不是一条错误）。
- **契约（硬约束）**：exporter 的出口**必须是 stderr**。
  stdout 是机器契约：`--json` 时是 NDJSON 事件流，不带 `--json` 时是最终答案本身。
  **禁止**在委托运行体里使用官方 `@deepseek-ai/cordis-plugin-logger-console`
  —— 它 `export()` 里是 `console.log`（= stdout），会破坏该契约
  （同 `dsh-sdk-jsonrpc-server` 文档对 stdout 纯度的要求）。
- **实现**：`packages/dsh-adapter/src/stderr-log.ts`（插件名 `alysia-log-stderr`，
  子路径 `@alysia/dsh-adapter/stderr-log`）。
- ⚠️ **级别语义容易读反**（`vendor/cordis/src/logger.ts`）：
  `LoggerLevel` = `ERROR 0 / INFO 1 / WARN 2 / DEBUG 3`，过滤判据是
  `targetLevel < level ⇒ 丢弃`，即 target 是**上限**。故 `levels: { default: 2 }`
  = 收 error + info + warn、丢 debug。

### +2.7.5 凭据来源：与同机既有的 dsh 服务共用一份 EnvironmentFile

- **实测**：服务器上 `web` profile 由 `dsh-web.service` 承载，
  `EnvironmentFile=/root/.dsh-web.env`（进程环境里可见 `DEEPSEEK_API_KEY`）。
- **契约**：委托运行体**复用同一个来源**，不另建一份凭据
  （否则「哪份是生效的」会成为一个新的静默分叉）。
- ⚠️ **安全纪律**：任何诊断输出**不得打印凭据值**。
  判定「有没有配」必须用 `[ -n "$VAR" ]` —— **不许**用参数展开的 `${VAR:-…}` / `${VAR:+…}`
  顺手把值带出来（本项目本次就是这么误打出一个真实 API Key 的）。

---

## ~§2.2（追加一段）

> 合并位置：`### 2.2 记忆 context(替代 MemoryRetrievalStage)` 末尾。

+  ⚠️ **鉴权（2026-10-17 补）**：`GET /api/persona/prompt`、`POST /api/memory/read`、
+  `POST /api/ingest`、`POST /api/sessions/:id/extract` 在 alysia **需要鉴权**的部署下
+  （容器内绑非回环地址 ⇒ `requireAuth=true`）一律要求 `Authorization: Bearer <token>`。
+  插件侧必须带上（见 §2.7.2）；漏带的表现是**所有桥接调用 401**，而 adapter 按设计
+  best-effort 降级 ⇒ 只表现为「记忆与人设都是空的」，**不会响亮失败**。
+  排查入口：`[alysia] GET /api/persona/prompt → HTTP 401` 这类限频 warn。

---

## ~§4（销账表新增一行）

| 项 | 状态 |
|---|---|
| 服务器侧运行体（独立 `alysia` profile + headless + adapter） | ⏳ 本 change 落地中（E01 只读连通验收） |
