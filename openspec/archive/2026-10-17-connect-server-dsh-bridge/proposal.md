# Change Proposal: connect-server-dsh-bridge

## 元信息

- **日期**: 2026-10-17
- **类型**: NEW（新功能）
- **状态**: **archived**（2026-10-17 归档；T1–T7 全部完成）
- **影响 spec**: `dsh-adapter`
- **关联**：外部计划 `docs/ALYSIA-DSH-BRIDGE-PLAN.md`；核查 `docs/ALYSIA-DSH-BRIDGE-FEASIBILITY.md`；
  实测 `docs/ALYSIA-DSH-BRIDGE-PROBE-2026-10-17.md`；盘点 `docs/ALYSIA-DSH-BRIDGE-SERVER-INVENTORY.md`

## 动机（为什么做）

目标是**让聊天侧的昔涟把工程任务委托给 dsh 里的昔涟执行**（详见外部计划的阶段 A–E）。
本 change 只做其中**第一段**：把 Alysia 桥接装到**服务器上那个已经存在的 dsh** 上，并完成 E01 只读连通验证。

**为什么是"服务器上那个"**（2026-10-17 只读盘点结论）：

| 事实 | 证据 |
|---|---|
| 服务器**已有** dsh `0.2.0-rc.2`（全局安装，Node v24.21.0） | `SERVER-INVENTORY` §1 |
| 其中 `web` profile **正在运行**（`:3080`，PID 13834，自 10-15） | `ps` / `ss` 实测 |
| 远程通道已存在（`ds-harness-remote@0.5.7`，E2E 加密） | 同上 §2 |
| `/root/alysia-ops` 是现成的固定工作区范式，且 **10-16 已由 dsh agent 真实做过一次生产修复** | 同上 §3 |
| 资源够用（可用 1208MB；dsh 常驻 193MB） | 同上 §1 |
| **但没有 Alysia 桥接**：无 adapter、无 patch 层、无 preset | 同上 §5（`grep -ril alysia /root/.dsh/profiles/` = 0） |

⇒ 缺的只有**装配**，不需要新机器、不需要新通道。

## 需求（做什么）

- [ ] 让 adapter 能在**需要鉴权的 alysia** 上工作（服务器侧 `/api/*` 强制 Bearer token）
- [ ] 把 `@alysia/dsh-adapter` 分发到服务器（服务器**不能连 GitHub**，本包**未发布 npm**）
- [ ] 在服务器上**新建**一个独立 profile 承载委托运行体，**不动正在跑的 `web` profile**
- [ ] E01：一次**无副作用**的连通验证 —— 返回任务身份 / 使用的模式 / 工作区确认，不修改任何文件
- [ ] 全过程留下可复核证据（命令 + 输出 + 回滚办法）

## 设计决策（怎么做，含备选与取舍）

### 1. 运行体选 `headless`，不复用正在跑的 `web` profile

`dsh --profile headless` 是**一次性进程**：建会话 → 提交 → 等静默 → 打印结果 → 退出，
不监听端口；`--session-id` 可续作同一会话（**已实测**，见探测报告 §2.3）。
委托任务天然是「一次一个动作」，不需要常驻服务。

**否决**：把 adapter 加进正在跑的 `web` profile —— 那是生产（用户在用、也被运维守护盯着），
且会让委托会话与用户自己的会话混在同一个 dsh 进程里。**R03「不动他人正在使用的东西」优先。**

### 2. 新建独立 profile（名字 `alysia`），不修改 `headless` / `web`

用 `@deepseek-ai/dsh-headless` 组合包 + 本包的 adapter bundle。
现有 `headless` profile 保持原样（它当前是干净的 `base + headless`，patch 为空）——
改动它会影响任何将来使用它的场景，且不好回滚。

### 3. 鉴权：给 `AlysiaClient` 加 token，缺省读环境变量（不引新机制）

**这是本 change 唯一的代码改动，且是硬前提**：服务器日志实测 `鉴权: 开`
（容器内绑 `0.0.0.0`，`/api/*` 强制 `Authorization: Bearer <token>`，仅 `/api/health` 豁免）。
而 `AlysiaClient` 现在**不带任何鉴权头** ⇒ 桥接装上去也会全 401。

做法：`AlysiaClientOptions.token`；缺省取 `process.env.ALYSIA_WEBUI_TOKEN`；
显式配置优先。两个插件（`index.ts` / `persona-variable.ts`）的 `Config` 各加一个 `alysiaToken`。

**否决**：给服务器上的 alysia 关鉴权 —— 那是降低生产安全边界，且与本仓 8-29 的
`cr-p0-webui-auth`（fail closed）设计意图相反。

### 4. 分发用「本地打包 → 上传 → profile 内 add」

服务器**不能连 GitHub**（`/root/alysia-ops/CLAUDE.md` 明写），本包也未发布到 npm；
但服务器**能访问 npm 源**（`ds-harness-remote` 就是这么装的）。
⇒ 本地 `npm pack` 出 tarball → `workbench upload` → `dsh plugin --profile alysia add <tgz>`。

⚠️ 打包前**必须重建 `dist/`**：实测桌面端正在跑的那份 `dist/` 停在 2026-10-02，
**不含** KI-23（`sessionIdOf` fail-closed）、KI-24（`delivery` 串行化/结算等待）与失败分类。
不重建就等于把旧缺陷一起搬过去（见探测报告 §6）。

### 5. `alysiaBaseUrl` 用 `http://127.0.0.1:6186`

6186 是宿主机映射端口（`127.0.0.1:6186->6185`）。**6185 是容器内端口**，在服务器上连不通。
桌面端那份配的 6185 是「本机跑 alysia」的场景，**不能照抄**。

### 6. 本次**不做**（有意不夹带）

- **记忆来源隔离**（外部计划 D10 / §八）：委托会话是「Alysia 自己发起」的 dsh 会话，
  需要来源标记以免进画像。它**不影响 E01 的只读连通**，且改动面横跨 adapter 与服务端 ingest
  —— 单独立项，避免与本 change 混成一个难回滚的大提交。
- **任务表 / 提交工具 / 状态同步 / 继续工程会话的接口**（计划阶段 C/D）。
- **博客建站**（E02/E03）与任何发布能力。
- 修服务器上 `web` profile 的既有状态、动 `alysia-ops` 工作区。

## 对账方向确认

- [x] 与现有 spec 冲突？→ **不冲突，是新增**：`dsh-adapter` spec §2.2/§2.5 描述的是
      「dsh 回传/读取 alysia」，本 change 补的是**部署鉴权**与**服务器侧运行体形态**，
      合并时新增 §2.7，并在 §2.2 的读通道契约里补一句鉴权要求。
- [x] 涉及 Web API？→ **不新增 alysia 侧接口**（复用 `/api/persona/prompt`、`/api/memory/read`、
      `/api/ingest`、`/api/sessions/:id/extract`），故 `docs/Web-API-Design.md` **不需要改**。

## 测试计划

| 层 | 内容 |
|---|---|
| 单元 | `alysia-client` 带 token 时发 `Authorization: Bearer`，不带时**不发**该头；显式 token 覆盖环境变量 |
| 回归 | `packages/dsh-adapter` 全部既有用例（含 `delivery` / `session-id` / `index`）保持绿 |
| 构建 | `npm run build` 后核对 `dist/` 含新代码（本 change 顺带修「dist 陈旧」） |
| 联调（E01） | 服务器上一次 `dsh --profile alysia --profile-headless`-风格的一次性任务：返回任务身份/模式/工作区；**证明人设来自 alysia**（而非静态兜底）；**证明未写任何文件** |

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| 服务器上装包污染现有 dsh | 只**新建** `alysia` profile；现有 `web`/`headless` 逐字不动；出问题 `rm -rf /root/.dsh/profiles/alysia` 即回到原状 |
| 上传/安装触发生产重启 | **不重启** `alysia-server`、不重启 `:3080` 的 dsh；本 change 全程不碰运行中的进程 |
| token 进入仓库 | token 只经**环境变量**注入（`ALYSIA_WEBUI_TOKEN`），代码里只出现变量名，不落任何字面量 |
| 把旧 dist 搬上服务器 | T3 强制先 build 再 pack，并核对 tarball 内含 `delivery` / fail-closed 版本 |
