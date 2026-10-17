# Tasks: connect-server-dsh-bridge

> **状态（2026-10-17）**：T1–T6 **已完成**（含验收过程中补做的 stderr 日志可观测性），
> 证据见 [`e01-evidence.md`](e01-evidence.md)。
> 未做：T7 的治理收尾（另开 change 记录仓库外的生产改动 / 登记后续项）、
> Apply 任务（合并 spec / 跑全仓测试 / 归档）。
> 🔴 **待用户处理**：E01 期间我误把服务器 DeepSeek API Key 打印进会话记录（用户已决定不轮换，
> 但**绝不可让它进仓库、备份或任何外发物**）。
>
> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> ★ 本 change **只碰**：本仓 `packages/dsh-adapter`（源码 + dist）、和一个**新建**的服务器 profile。
> **不碰**：正在运行的 `alysia-server` 容器、`:3080` 的 dsh web profile、`/root/alysia-ops`、
> `/root/alysia/data/`（她的记忆）。

## 实现任务

### T1 — adapter 支持 Bearer 鉴权（硬前提）✅

- [x] `alysia-client.ts`：`AlysiaClientOptions` 加 `token?: string`；构造时缺省取
      `process.env.ALYSIA_WEBUI_TOKEN`；请求头在有 token 时加 `Authorization: Bearer <token>`
- [x] 单测：有 token → 带头且值正确；无 token → **不带**该头；显式 token 优先于环境变量
- [x] `index.ts` / `persona-variable.ts` 的 `Config` 各加 `alysiaToken?: string` 并接到 client
- [x] 附带：新增 `src/node-env.d.ts`（本包刻意不依赖 `@types/node`，只声明用到的 `process`）

### T2 — 重建 dist 并打包 ✅

- [x] `tsc -p tsconfig.json` 重建（`dist/` 从 10-02 → 10-17）
- [x] 核对 `dist/` **确实含** `IngestDelivery`（KI-24）与 fail-closed 版 `sessionIdOf`（KI-23）
- [x] `npm pack` → `alysia-dsh-adapter-0.1.0.tgz`，sha256 `a3f3bb8a75d4168d4079511c52df1c5d1a8ad8f43876fe32a6337f0349676230`（双边一致）

### T3 — 上传到服务器 ✅

- [x] `scp` → `/root/alysia-dsh-adapter-0.1.0.tgz`
- [x] 服务器侧 `sha256sum` 与本机一致

### T4 — 新建服务器 profile `alysia`（不动现有 profile）✅

- [x] 动手前锚点已记录（profiles = headless/web；dsh PID 13834；容器 healthy）
- [x] `/root/.dsh/profiles/alysia/`：bundles = base + headless（adapter 由 add 自动并入）
- [x] `dsh plugin --profile alysia add <tgz>` 成功
- [x] patch 层：`alysiaBaseUrl: http://127.0.0.1:6186`；`alysiaToken: !!js process.env.ALYSIA_WEBUI_TOKEN`
- [x] `--dump-config` 核对：`alysia-persona` 顶层行 = 1（修正了 bundle 自带 patch 导致的重复行）
- [x] 确认 `web` / `headless` profile 未被改动（mtime 未变）

### T5 — E01 无副作用连通验证 ✅（含一处未取得证据）

- [x] 任务内容：确认身份/模式/工作区，**明确要求不修改文件**
- [x] `--json` 运行两次（带 / 不带 token），exit 0，拿到 `sessionId` 与 `cwd`
- [x] 人设来源判定：HTTP 直测（`/api/persona/prompt` 401 vs 200，正文 **16348 B**）
      + B 组回答内容提到 `soul.md` / `identity.md` / `worldview.md`（静态兜底仅 417 字符且只在注释里提过）
- [x] 无副作用：工作区跑前/跑后逐字一致
- [x] ~~⚠️ **未取得**：预期的 adapter 日志行~~ → **已在 T6 内解决**：
      拿到 `[alysia-persona] 人设已更新（6375 字）` 与 `session/event user|assistant`（见证据 §5.4）

### T6 — headless 形态的日志可观测性（T5 验收时暴露的缺口，本 change 内补做）✅

> 为什么夹带进来：E01 的**人设判据**原本要靠 adapter 的日志行，实测发现**一条都看不到**。
> 不补这个缺口，E01 的验收只能靠「回答内容」，而后续每次委托都会「只能看结果、看不到过程」。

- [x] 定位根因：cordis 默认只挂**内存环形缓冲** exporter；官方打印用的 `logger-console`
      行在 dsh 的 base/headless/web-app 组合包里**都不存在**
- [x] 新增 `src/stderr-log.ts`（插件名 `alysia-log-stderr`，子路径 `@alysia/dsh-adapter/stderr-log`）
      + 9 条单测（含「**绝不许碰 stdout**」的反向守卫）
- [x] 服务器验收：stdout 8 行 NDJSON **零污染**；stderr 出现
      `人设已更新（6375 字）` 与 `session/event user|assistant` 两行
- [x] 契约写进 spec delta §2.7.4 / §2.7.5

### T7 — 治理收尾（本 change 内）

- [x] 证据写进 `e01-evidence.md`
- [x] ⚠️ **另开 change 记录 10-16 那次仓库外生产改动** →
      `openspec/changes/record-out-of-band-server-config-change/`（**pending**）
- [x] 登记后续项：记忆来源隔离（D10，下一个 change）、任务表与提交工具（阶段 C/D）；
      headless 日志落点已在 T6 内解决（不再是遗留）
- [x] 🔴 凭据处理：用户明确**不轮换**（会话记录不外传）；
      纪律已写进 spec §2.7.5（判定「有没有配」用 `[ -n "$VAR" ]`，不许用 `${VAR:-…}`）

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/dsh-adapter/spec.md`（新增 §2.7；§2.2 补鉴权；§4 销账表加一行）
- [x] 更新 `openspec/specs/index.md`（dsh-adapter 行：最后变更 → `2026-10-17 connect-server-dsh-bridge`）
- [x] 运行 `packages/dsh-adapter`（**123 passed**）+ 全仓常规测试（**111 文件 / 1277 passed，exit 0**）
- [x] 跑 `scripts/check-spec-diff-residue.cjs` → **exit 0（无残留）**
