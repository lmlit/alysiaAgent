# Alysia ↔ dsh 打通计划：可行性核查（2026-10-17）

> 对象：[`ALYSIA-DSH-BRIDGE-PLAN.md`](ALYSIA-DSH-BRIDGE-PLAN.md)（ChatGPT-6-Astra 草拟）。
> 本文只做**核查与判定**，不改代码、不部署、不连服务器。
> 核查方式：本仓 spec / KNOWN-ISSUES / HANDOFF 只读比对 + 已安装 dsh 发行版（`E:\dsh\resources\app.asar`）
> 与通用 dsh 源码检出（`E:\workSpace\deepseek-harness-master`）的只读检索。
> ⚠️ 凡标注「未实测」的，都不构成支持/不支持的结论 —— 那正是原计划 A05 要做的活。
>
> ★ **2026-10-17 补**：A05 的**实测**已完成，见 [`ALYSIA-DSH-BRIDGE-PROBE-2026-10-17.md`](ALYSIA-DSH-BRIDGE-PROBE-2026-10-17.md)。
> 该实测**推翻了本文两处结论**（E4 与 A05 表的「续作」行，已就地更正并标注）——
> 已安装发行版的行为**优于**其源码文档：headless 支持 `--session-id` 续作与 `--json` 机器可读事件流。

---

## 0. 结论（先看这段）

**目标可行，方向正确，但不能按原计划的前置假设开工。** 三处前提错误会直接把执行模型卡死在阶段 A：

| # | 原计划的假设 | 实际 | 后果 |
|---|---|---|---|
| 1 | ~~dsh 在**服务器**上~~ → ★ **2026-10-17 二次更正：原假设成立，是我判错了。** 服务器上**确实有 dsh**（0.2.0-rc.2，10-15 迁移当晚装好，**web profile 正在 :3080 运行**），另有桌面端一份 Electron 发行版（本仓 `dsh-adapter` 以 `link:` 挂在那边）。详见 [`SERVER-INVENTORY`](ALYSIA-DSH-BRIDGE-SERVER-INVENTORY.md) | 只读 SSH 盘点（`ps` / `ss` / `ls` / `cat`）；我最初判「错」的依据只是本仓文档，而**文档只记了桌面端、且资源数字来自杭州旧机** | A02/A05 的原文前提**成立**；反向通道（`ds-harness-remote`）也已装好，**不必新增**。仍然要新增的是 A00：**在服务器 dsh 与桌面 dsh 之间做选择/分工** |
| 2 | 阶段 B「修复基础回传/幂等/结算/来源」是待办 | B01/B02/B03/B04/B05/B07 对应的 change **都已实现并归档**（见 §5） | 执行模型会把已完成的工作重做一遍，违反 R08 |
| 3 | 工作模型是 `deepseek-v4.1-flash`（R09） | 本仓实际是 **`deepseek-v4-flash`**（`CLAUDE.md`、`.env.example`、dsh 侧 profile 的 `agent-default-model` 配置） | R09 会把执行模型送去核一个不存在的模型映射，属噪音 |

**同时，原计划最担心的那个未知项（A05「dsh 到底有没有可编程入口」）答案是「有，而且是官方的」** ——
比计划预期乐观得多。已安装的桌面发行版里**已经打包**了 `@deepseek-ai/dsh`（CLI 启动器）、
`dsh-headless`、`dsh-sdk-app` / `dsh-sdk-minimal`（SDK 运行体）、`dsh-sdk-jsonrpc-server`、`dsh-acp-app`：
证据是在 `app.asar` 中检索到的 bundles 清单原文
（`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-headless`、`dsh-sdk-app`、`dsh-sdk-minimal`、`dsh-acp-app`）。

一句话：**可行性瓶颈不在 dsh 有没有接口，而在「哪台机器跑 dsh runtime」和「服务器还剩多少内存」。**

---

## 1. 核查到的事实与证据

| # | 事实 | 证据（可复核） | 对计划的影响 |
|---|---|---|---|
| E1 | 已安装 dsh = `@deepseek-ai/dsh-desktop` **0.2.0-rc.2** | `E:\workSpace\.asar-x\out\package.json`（从 `E:\dsh\resources\app.asar` 解出） | A02 的「dsh 版本」有确定答案；但它是**发行版**，不等于源码检出 |
| E2 | 通用 dsh 源码检出在 `E:\workSpace\deepseek-harness-master`，version **0.1.0-rc.5**（低于已安装发行版） | 该目录 `package.json` | ⚠️ **不能用它断言已安装版的行为**；只能作接口形状/文档依据。R05 要加这条区分 |
| E3 | 官方入口一（CLI）：`dsh --profile headless "任务"` —— 建一个**全新的、持久化的** Agent，提交任务，等静默，打印最后一条非空 assistant 文本，`completed` 退出 0，否则 1；**不监听端口** | `apps/cli/README.md:9-16`、`apps/cli/reference/README.md:28-30` | 「创建会话 + 提交任务 + 取结果」有正式 CLI 路径 |
| E4 | ~~headless 的 app 参数**只有一个位置参数（任务文本）**，**没有** preset / 工作区 / resume 参数~~ → ★ **2026-10-17 实测推翻**：headless 还有 `--json`（NDJSON 事件流）与 **`--session-id <id>`（续作已有会话）**，任务也能从 stdin 读；源码文档 `reference/README.md:23-30` **落后于发行版** | 探测报告 §2.1/§2.3（`dsh --profile headless --help` 实测输出） | 「继续已有会话」**可以**走 CLI；「选择 Alysia 模式」仍然不行（见 E9） |
| E5 | 官方入口二（TS SDK `@deepseek-ai/dsh-sdk-client`）：以子进程方式拉起 runtime，走 stdio JSON-RPC；`DeepSeekHarness.run()`；`session(id?)` 打开**具名会话**；`InitializeParams` 含 **workspace cwd（绝对路径）/ provider / model / maxTokens** | `packages/sdk/client/README.md:13-32` | 「创建会话 / 工作目录 / 提交任务 / 取结果 / **同一会话续作**」在这条路径上齐了 |
| E6 | 官方入口三（Python SDK `deepseek-harness` + runtime wheel）：单文件 runtime，固定 tag 为 `manylinux_2_28_x86_64` / `aarch64` / `macosx_14_0_arm64` —— **没有 Windows wheel** | `python/README.md`、`python/sdk-runtime/README.md:18` | Linux 服务器有官方 runtime 载具；**桌面端要走 Node 载具 / 已装发行版** |
| E7 | 协议层**没有 cancel / session-close**：「a client abandons a turn by closing the runtime process」 | `packages/sdk/protocol/README.md:38`、`packages/sdk/client/README.md:47` | 原计划「取消能力根据 A05 核实结果决定」→ **结论已可给出：不支持**。计划 §七「远端取消能力不可用 → 明确显示无法确认停止」的口径是对的，照做即可 |
| E8 | 状态是**真实事件订阅**：服务端主动推 `session.status`（whole-agent running/idle）、`session.event`（全部会话事件）、`subagent.started/finished` | `packages/sdk/protocol/README.md:20-23` | 原计划 D05「有限频率查询**或**真实事件订阅」→ 选后者，不必轮询 |
| E9 | preset 由**会话创建方/组合**决定，**SDK 协议里没有 preset 字段**（全 `packages/sdk` 目录 grep `preset` = 0 命中）；`agentPresets.default` 可由配置/设置给出；会话 header 冻结创建时的 preset，切换是 `agent-preset/selected` 事件 | `packages/preset/agent-presets/README.md:13,43-45,104-113`；sdk 目录 grep | **「按任务选 Alysia 模式」不支持**；只能把**运行体的默认 preset 固定成 Alysia**。这直接改写 A03/D01 的写法 |
| E10 | 工作区与权限：**调用目录即默认工作区根**；新会话默认 **`workspace-write`** 权限预设，bash/文件写入限制在会话工作区内；`DSH_PERMISSION_MODE` / `DSH_TOOLS_MODE` 是进程级开关；`AGENTS.md` / `CLAUDE.md` 以 64KB 预算加载 | `apps/cli/reference/README.md:68,70,72` | A06「能限制博客执行环境」→ **有现成机制**；D01 的隔离要求可满足 |
| E11 | 桌面端 profile **就在用本仓的 dsh-adapter**：`~/.dsh/profiles/desktop/package.json` 里 `"@alysia/dsh-adapter": "link:E:/workSpace/alysiaAgent/packages/dsh-adapter"` | 该文件 | R01「禁止在本地修改代码」与现状冲突（见 §7.R01）；且改 `src/` 后必须 build + **重启桌面端**才生效（走 `dist/`） |
| E12 | 本机存在**两个**候选 Alysia preset：`~/.dsh/.agent-presets/alysia/`（旧形态，`agent.cordis.yml` 直接引 `.../dsh-adapter/src/index.ts`）与 bundle 声明的 `alysia-standard`（`packages/dsh-adapter/cordis.patch.yml`，派生自 standard，order 10） | 两处文件 | A03 必须先裁决「用哪个」；计划只写了「核实 preset ID」，没写「可能有多个」 |
| E13 | 文档漂移（**待核实到已安装版本**）：`openspec/specs/dsh-adapter/spec.md` §5 称 `.agent-presets/`「已废弃、app.asar 内无任何代码引用」；而 `packages/preset/agent-presets/README.md:20,96` 说 `includeUserRoot` 默认 true、该目录就是**可写的 user root** | 两处 doc | 两条说法不可能同时成立。⚠️ 我读的是 **0.1.0-rc.5 源码**，不能推翻 spec 里对 0.2.0-rc.2 的实测结论 —— 列为 A03 的必查项 |
| E14 | 现存 Alysia↔dsh 通道是**单向**的：`POST /api/ingest`（写）、`POST /api/memory/read`、`GET /api/persona/prompt`、`POST /api/sessions/:id/extract` —— 全部是 **dsh 当客户端、server 当服务端** | `dsh-adapter` spec §2.2/§2.4/§2.5 | 原计划要的「server 提交任务给 dsh」**方向相反**，现有代码里没有任何承载物。这是本期真正的新增工程 |
| E15 | server 侧只有聊天工具：`features: { codeMode: false }`；能力开关机制（`AlysiaFeatures`）现成 | `CLAUDE.md`「AlysiaFeatures 能力开关」；`packages/core/src/modules/capabilities.ts` | D09「工具注册 + 能力开关」有现成落点，可行 |
| E16 | ~~服务器资源紧张~~ → ★ **2026-10-17 更正：那是杭州旧机的数字。** 北京新机实测 **1870MB 总 / 可用 1208MB** / 4GB swap / 盘剩 25G；正在跑的 dsh web 常驻仅 **193MB** | `docs/KNOWN-ISSUES.md`「同批次发现」节写的是旧机 → 已由只读 SSH 实测取代（SERVER-INVENTORY §1） | 资源**不再是**否决性风险；计划仍应加一条资源门槛，但结论会是通过 |
| E17 | 本机 dsh 会话日志可解（多帧 zstd，`~/.dsh/sessions/<工作区>/session-*/session.v4.jsonl.zstd`），含模型看到的完整 system prompt | `dsh-adapter` spec §5 | E05 验收有**决定性证据源**，不必靠自述 |

---

## 2. A05 接口证据表（预填版 —— 执行模型要把它做成实测）

| 能力 | 真实入口 | 输入/输出 | 证据 | 结论 |
|---|---|---|---|---|
| 创建工程会话 | SDK `harness.session(id?)` / CLI `--profile headless "<task>"`（每次全新） | 会话 id / 退出码 | `packages/sdk/client/README.md:24`、`apps/cli/reference/README.md:30` | **支持** |
| 选择 Alysia 模式 | ❌ 不能按会话指定。只能把运行体的 `agent-presets.default` 固定为 Alysia preset | — | `packages/preset/agent-presets/README.md:13,88`；sdk 目录 grep `preset` = 0 | **仅支持「运行体级默认」，不支持「任务级」** |
| 设置工作目录 | SDK `initialize` 的 workspace cwd（绝对路径）/ CLI 以**调用目录**为根 | 绝对路径 | `packages/sdk/client/README.md:24`、`reference/README.md:68` | **支持**（SDK 更明确） |
| 提交任务 | `run(input)` / 协议 `session/prompt` | `UserMessage` 的 `messageId`（只表示入队受理） | `packages/sdk/client/README.md:26-30` | **支持** |
| 查询执行状态 | 订阅 `session.status`（running/idle）+ `session.event` | 通知流 | `packages/sdk/protocol/README.md:20-23` | **支持**（无「任务态」概念，`needs_review` 等要自建） |
| 获取结果或产物 | `RunResult.finalResponse` / headless stdout / 会话事件流 | 文本 + 事件 | 同上 | **支持**（产物文件要自己收） |
| 继续已有会话 | ★ 已实测：headless **`--session-id session-…`**（同一会话 `turn: 2`、正确回忆前轮 codeword）；SDK 的 `session(id)` 是另一条路 | 会话 id | **探测报告 §2.3**（本条推翻了原先「仅 SDK 支持」的判断） | **支持** |
| 取消任务 | ❌ 协议无 cancel / session-close，只能**关闭 runtime 进程** | — | `packages/sdk/protocol/README.md:38` | **不支持** |

> 余下 3 项（preset 名的实际可解析性、权限边界、凭据可见范围）需要在**已安装的 0.2.0-rc.2** 上实测，
> 不能拿 0.1.0-rc.5 源码下结论。

---

## 3. 拓扑：本期真正的决策点

现有代码只支持 **dsh → server**。原计划要的是 **server → dsh**，所以第一件事不是写代码，而是**选在哪台机器放 dsh runtime**。

| 路线 | 形态 | 优点 | 代价 / 风险 | 判定 |
|---|---|---|---|---|
| **1. 服务器侧 runtime** | 在 alysia server 上跑一个 dsh runtime（headless / web），server 自己提交任务 | ★ **2026-10-17 实测：这条路已经预置好了** —— 服务器上 dsh 0.2.0-rc.2 已装、web profile 正在 `:3080` 跑、`ds-harness-remote` 提供 E2E 远程入口、`/root/alysia-ops` 是现成的固定工作区范式，**且 10-16 已由 dsh agent 真实做过一次生产修复**。同机 `127.0.0.1:6186` 直连 alysia API；来源标记由提交方自己掌握（见 §4） | ① ~~内存~~ **已解除**（可用 1208MB，dsh 常驻仅 193MB）；② ~~需新的 Linux 运行体~~ **已解除**（装好了）；③ 预览在服务器上、用户看不到（除非 server 托管，而 R11 不许动 nginx）；④ ⚠️ **目前没有 Alysia 桥接**（无 adapter、无 patch 层、无 preset）——这是唯一真正缺的装配 | **★ 首选**（见 SERVER-INVENTORY §5） |
| **2. 驱动桌面端已运行的 dsh** | server 反向调用桌面 dsh | 复用桌面 dsh 上**已经装好的 Alysia 人设/记忆**（那边 adapter 已挂） | ① 桌面在 NAT 后（服务器→桌面的入站通道仍未解）；② 桌面 GUI 的 host API 是私有协议（401 鉴权、自称 pre-release）——**与 R05 冲突** | **不建议** |
| **3. 桌面端插件拉取任务** | 装一个 dsh 插件，轮询 server 任务表并在 dsh 内起会话 | 复用桌面 dsh | 「在插件里创建新会话」要用的是 Host/Core 面能力（`agentPresets.mount()` 等，`packages/preset/agent-presets/README.md:16,29-31` 明说 `mount()` 的**唯一受支持调用点是 agent 工厂的 `setup()`**），**不是给插件用的 consumer API**；且 preset standing mount 与「新会话由插件创建」无对外契约 | **风险高** |
| **4. 桌面端独立 runner 进程** | 另起一个常驻 Node 进程（非插件），用 CLI/SDK 拉起 dsh runtime；任务表放 server，runner 主动 HTTP 拉取 | **已实测跑通**（探测报告 §2）：`dsh --profile headless --json` 建会话 / 定工作区 / 提交 / 读状态 / 取结果 / `--session-id` 续作 / `--patch` 注人设，全部通过；**出站连接，无 NAT 问题**；博客工程与预览就在用户眼前 | 桌面常驻一个进程；**Alysia 人设/记忆同样需要在桌面上装装配**（与路线 1 等价的工作量） | **次选**（博客要留在用户桌面时用它） |

**建议**：~~先做两条候选的最小 launch 实测~~ → ★ **2026-10-17 已完成**（探测报告）。
结论：**路线 1（服务器侧）已经预置好，是首选**；只差把 Alysia 桥接装上去（SERVER-INVENTORY §5）。
路线 4 也已验证可行，作为「博客必须留在桌面看预览」时的备选。

---

## 3.5 补充：服务器侧还发现了什么（2026-10-17 只读盘点）

详见 [`ALYSIA-DSH-BRIDGE-SERVER-INVENTORY.md`](ALYSIA-DSH-BRIDGE-SERVER-INVENTORY.md)。三条要点：

1. **服务器上 dsh 已装、已在跑、已干过活**：`dsh --profile web --port 3080`（10-15 起），
   `/root/alysia-ops` 是现成的固定工作区范式（`CLAUDE.md` 运维手册 + `alysia.sh` 助手 +
   bwrap 沙箱里的健康守护），**10-16 由 dsh agent 真实执行过一次生产修复**（config.yml 两个
   `max_tokens` 槽位，带备份/回滚/验收）。
2. **远程通道已存在**：web profile 装了 `ds-harness-remote@0.5.7`（E2E 加密，桌面/网页/Android）。
   可行性分析原来说的「远端驱动只能用 GUI 私有 API」需要修正。
3. **但服务器 dsh 没有 Alysia 桥接**：无 adapter bundle、无 patch 层、无 preset ——
   `grep -ril alysia /root/.dsh/profiles/` = 0 命中。**这就是本期唯一缺的装配。**

⚠️ **顺带暴露一个治理问题**：10-16 那次生产 `config.yml` 改动**在仓库外**、
**没有走 OpenSpec**，本仓的 `config.example.yml` / sampling 默认值里看不到它。
按 `openspec/project.md` 的对账规则，这属于「impl 已经变了、doc 没有」→ 应当**补一个 change 记录**，
否则下一个人会以为线上跑的是仓库里的默认值。

---

## 4. 记忆污染回路（原计划 §八）：判定与简化

原计划的诊断是对的，而且**本仓已经堵掉了它的两个近亲**：

- 子 agent 会话：`session.header.origin === 'subagent'` → 不回传、不结算（`dsh-adapter` spec §2.5）。
- dsh 合成注入：`data.message.source.kind === 'runtime-context'` → 结构化判据（**明确否决了文本前缀判据**）
  → 服务端打 `skip_profile` + `synthetic`（同节，KI-20）。

**新缺口**是真的：委托任务是**第一个由 Alysia 自己发起、而不是用户敲键盘发起**的 dsh 会话。

**但原计划 §八 第 4 条（「如果 dsh 不支持所需标记，就关闭该会话的学习」）大概率用不上**，理由：

> 走**路线 1 或 4** 时，**提交方就是 server 自己** —— 它从 SDK 的 `RunResult.sessionId` 直接拿到 `dshSessionId`，
> 写进任务表即可。`/api/ingest` 收到的每条 dsh 事件都带 session id，服务端查一次任务表就能判定
> 「这是委托任务会话」→ 打 `skip_profile`。
> **标记不需要 dsh 支持，也不需要它跟着消息跨境来回。**

只有当委托发起方在**另一台机器**（路线 2/3）时，「标记必须挺过 server→桌面→server 的往返」才成为真问题 ——
那正是原计划担心的情形，而它同时是**最不该选的拓扑**。

一句话：**把拓扑定成「本地提交」，原计划 §八 里最容易失控的那一条自动降级为一条 SQL 判断。**

---

## 5. 阶段 B 的实际状态（原计划已过期）

| 原计划 | 对应 change / 位置 | 实际状态 |
|---|---|---|
| B01 会话身份校验（KI-23） | `fix-dsh-ingest-and-settlement`，契约 7 | ✅ **已实现并归档** |
| B02 事件幂等（KI-12） | `fix-store-write-trace`，契约 9 | ✅ **已实现并归档** |
| B03 分批回传（单批上限） | `fix-dsh-ingest-and-settlement`，契约 1 | ✅ **已实现并归档** |
| B04 在途串行化与结算（KI-24） | 同 change，契约 2/5/6 | ✅ **已实现并归档** |
| B05 合成消息来源核对（KI-20） | `filter-synthetic-context-inflow` | ✅ **已定案并实现、归档**（判据已改为结构化 `source.kind`） |
| B06 已有反思修复状态 | — | ⏳ **仍是有效任务**（属「部署核对」类，见下） |
| B07 迟到事件窗口 | `fix-summary-window-late-events`（`ended_at` 取数据边界） | ✅ **已修并归档**；原计划的"验证 cron 是否会越过在途消息"已被该 change 的 §5.4.1 契约 4 回答 |

⇒ **阶段 B 应从「修复」改写为「部署核对」**：核实线上镜像是否含上述 change。
这不是形式主义 —— 本仓有明确前车之鉴：线上镜像曾落后 `HEAD` **6 天**，9-27 之后所有修复都没生效
（`docs/HANDOFF.md`「根本背景」节）。
⚠️ 而**这一核对必须碰服务器**（只读 `docker inspect` 看镜像构建时间 / 查日志里有没有 `[LLM:memory]` 行），
与原计划开头的「不调用服务器」自相矛盾 —— 需要用户单独放行一次只读核对。

---

## 6. 原计划没覆盖的三个硬缺口

1. **资源门槛（最严重）**。E16：可用内存 ~180MB。原计划 A01–A06 没有任何一项问「这台机器跑得动吗」。
   建议新增 A00-b：确认 dsh runtime + 建站工具链的内存预算，必要时先扩容/腾内存/换机器。
2. **运行体分发**。已安装的是 Windows 桌面包；服务器需要 Linux 载具。
   `python/sdk-runtime` 有 `manylinux_2_28_x86_64` wheel，但它是 **Python 生态的载具**，
   而本项目是 TypeScript；用 `@deepseek-ai/dsh`（npm）还是移植 wheel，**必须先核实再决定**（R05）。
3. **预览怎么给用户看**。E02/E03 的通过条件写着「预览可以被用户查看」。
   若 runtime 在服务器上，用户看不到页面；本仓**没有**渲染并截图网页的链路
   （`vision-bridge` 只有「把图片喂给 GLM-4V-Flash 描述」，不产生截图）。
   server 侧截图要引入 Playwright/Chromium —— 与缺口 1 直接叠加。
   ⇒ 首版建议：**预览由用户自己看**，聊天侧 Alysia 不声称「看过页面」（原计划 E03 已写对，照做）。

---

## 7. 对原计划的逐条修订建议

| 编号 | 原文 | 建议改为 |
|---|---|---|
| 新增 A00 | — | **先定拓扑**：runtime 放服务器（路线 1）还是桌面（路线 4）；两条各做一次最小 launch 实测 |
| 新增 A00-b | — | **资源与载具门槛**：内存预算 + Linux/Windows 运行体获取方式 |
| A02 | 「记录 Alysia 提交、dsh 版本…」 | 明确写「dsh **不在**服务器上」这一默认事实；版本记 `@deepseek-ai/dsh-desktop 0.2.0-rc.2`，并**区分发行版与源码检出**（E1/E2） |
| A03 | 「找到 Alysia 模式」 | 加一句：**本机同时存在 `alysia`（旧 `.agent-presets` 形态）与 `alysia-standard`（bundle 声明）两个候选**，先裁决用哪个（E12）；并核实 `.agent-presets` 是否仍被读取（E13 文档漂移） |
| A05 | 接口证据表 | 用本文 §2 预填表作为起点，逐项**在已安装 0.2.0-rc.2 上实测**；preset 一项的结论已可预判为「不支持任务级选择」 |
| A06 | 「检查 dsh 的目录限制、工具授权」 | 已有答案：默认 `workspace-write`、bash/写限会话工作区、`DSH_PERMISSION_MODE` / `DSH_TOOLS_MODE`（E10）。任务改为「把博客工作区固定在登记路径，并证明越界写被拒」 |
| B01–B05、B07 | 「修复…」 | 改为「**核对线上部署是否包含** <change 名>」（§5 表）；B06 保留 |
| R01 | 「禁止在本地修改代码」 | 与实际冲突且无必要：本仓就在本地开发，且**桌面端的 dsh-adapter 正是以 `link:` 指向本仓**（E11）。建议改为「**不在运行中的容器/生产目录里直接改文件**；部署一律走 `docs/Docker-Deployment.md`；不改生产库」 |
| R05 | 「不猜 …」 | 补一句：**证据必须标注来自「已安装发行版」还是「源码检出」**，二者版本不同（E1/E2） |
| R09 | `deepseek-v4.1-flash` | 改为 **`deepseek-v4-flash`**（本仓实际值），并保留「服务端标识不同则先核实」 |
| D05 | 「有限频率查询**或**真实事件订阅」 | 明确选**事件订阅**（`session.status` / `session.event`，E8） |
| D08 | 「使用保存的 `dshSessionId`」 | ★ 已实测可行：`--session-id <id>` 续作同一会话（探测报告 §2.3）；`dshSessionId` 由 `--json` 首行直接给出，**不需要猜**。SDK 常驻进程只是备选 |
| 取消能力 | 「根据 A05 核实结果决定」 | 直接定案：**不支持**（E7）。计划原文「不能把本地不再等待伪装成远端已经停止」的口径保留 |
| §八 第 4 条 | 「若 dsh 不支持所需标记，关闭该会话学习」 | 走本地提交路线时**不需要**此退路：来源标记由提交方自己写进任务表（§4）。保留该条仅作远端拓扑的兜底 |
| R07 / 全文 | 未说明与 OpenSpec 的关系 | 明确写：**本文件不是 change**；采纳后必须先 `/openspec-change` 立项（本仓治理见 `openspec/project.md`） |

---

## 8. 建议的修订版顺序

```text
A00   拓扑决策 + 两条候选的最小 launch 实测     ← 新增，先做
A00-b 资源与运行体获取门槛                      ← 新增
        ↓ G0（含：A05 证据表实测完成）
B'    部署核对（不是修复）：线上镜像是否含既有 change + 只读核对
        ↓ G1
C     任务契约（按 §2 实测结果改写：无 cancel、preset 运行体级、续作仅 SDK）
        ↓
D     提交 / 结果 / 续作（来源标记走「任务表 + ingest 判定」，不需 dsh 配合）
        ↓ 模拟执行器测试
E01 → E02–E03（预览由用户看）→ E04 → E05
```

---

## 9. 需要用户拍板的事

1. **dsh runtime 放哪台机器**（服务器 / 桌面 runner）—— 决定后面全部工程；也决定博客源码与预览的落点。
2. **是否放行一次只读的线上核对**（`docker inspect` 镜像时间 + 日志检索）—— 阶段 B 的实际前提，与「不调用服务器」冲突。
3. **Alysia preset 用哪个 id**（`alysia` 旧形态 / `alysia-standard` bundle 声明）。
4. **预览的验收方式**：首版是否接受「用户自己看，聊天侧不声称看过」。
5. **是否现在就把本计划转成 OpenSpec change**（本仓纪律：写代码前先立项）。
