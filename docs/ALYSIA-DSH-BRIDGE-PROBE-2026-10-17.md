# dsh 调用面实测报告（2026-10-17）

> status: record · updated: 2026-10-17 · audience: ai
> ⚠️ 时点记录 + **被 `specs/dsh-adapter/spec.md` §2.7 引用为证据**：**不要移动或删除本文件**。

> 起因：[`ALYSIA-DSH-BRIDGE-FEASIBILITY.md`](ALYSIA-DSH-BRIDGE-FEASIBILITY.md) 判定
> 「A05 是本计划唯一真正决定成败的未知项」。本报告就是 A05 的**实测**结果。
> 全部测试跑在**隔离探测区** `E:\workSpace\alysiaAgent\.probe\`（已加 `.gitignore`），
> **不碰**用户日常的 `~/.dsh`（独立 `DSH_HOME`）、不碰服务器、不改本仓代码。

## 0. 一句话结论

**委托运行体已经跑通了。** 官方 CLI `@deepseek-ai/dsh@0.2.0-rc.2`（**npm 公开发布，与已安装桌面端同版本**）
可用 `--profile headless --json --session-id` 完成「建会话 / 定工作区 / 提交任务 / 读状态 / 取结果 / 续作」，
并且**人设可以经 `--patch` 注入并直达模型**。取消能力确实不存在（与协议文档一致）。

> ★ **本报告推翻了可行性分析里的一处结论**：我此前依据 `apps/cli/reference/README.md:28`
> 判定「headless 只接受一个位置参数、不支持 resume」。**实测该文档落后于发行版**：
> 0.2.0-rc.2 的 headless 有 `--session-id`、`--json`，还能从 stdin 读任务。
> ⇒ 教训与可行性分析 E2 完全一致：**已安装发行版 > 源码检出 > 文档**。

## 1. 探测环境

| 项 | 值 |
|---|---|
| dsh CLI | `@deepseek-ai/dsh@0.2.0-rc.2`，npm 安装到 `.probe/dsh-cli`（**537 包**，`--ignore-scripts`） |
| Node | `E:\nodejs24\node.exe` **v24.19.0**（PATH 里的 v20.16.0 不满足运行时要求） |
| DSH_HOME | `.probe/dsh-home`（**独立**，profile/sessions/storages 全在里面） |
| 工作区 | `.probe/blog-workspace`（空目录） |
| 凭据 | 只把本仓 `.env` 的 `OPENAI_API_KEY` 重映射为进程环境变量 `DEEPSEEK_API_KEY`（**未读未打印任何值，未改动用户凭据文件**） |
| 真实 LLM 调用 | **4 次**，单次 5–15 秒，token 消耗可忽略 |

⚠️ 安装时 npm 生命周期脚本触发沙箱的 `spawn EPERM`（文档化的管道 stdio 边界），
改用 `--ignore-scripts` 完成安装（**重构命令，不是原样重试**）。本机装 dsh 时同样需要这一手。

## 2. 实测结果（逐项）

### 2.1 CLI 命令面（`dsh --help` / `dsh --profile headless --help`，实测输出）

```
$ dsh --profile headless --help
Usage: dsh --profile headless [options] [task...]
  task               the task text; multiple words are joined by spaces, and `-` reads stdin
  --json             write newline-delimited run events to stdout instead of the final message
  --session-id <id>  adopt the persisted Session with this id; an unknown id is an error
```

启动器另有 **`--patch <path>`（可重复）**、`--dump-config`、`--from-default-profile`。

### 2.2 建会话 + 提交任务 + 取结果

```
$ dsh --profile headless --json "Remember this codeword: ORANGE-7741. Reply DONE."
{"type":"session","sessionId":"session-19256c3c-8864-42bc-92cd-7cd4a0413f63","cwd":"E:\\workSpace\\alysiaAgent\\.probe\\blog-workspace"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"thinking","text":"…"}
{"type":"text","text":"DONE"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":4916,"outputTokens":196,…}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"DONE"}
```

**这是直接的接口证据**：
- **首行给 `sessionId` 与 `cwd`** ⇒ 提交方**不需要猜**会话 id（原计划 `dshSessionId`「经真实响应确认」可满足）
- **`cwd` 回显** ⇒ A05「设置工作目录」可验证（实测 = 调用目录）
- `status.phase` + `usage` ⇒ 「查询执行状态」
- `turn_end.reason.kind` ⇒ **终态判据**（原计划 `completed` / `failed` 的区分有了直接依据）
- `final.text` ⇒ 「获取结果」；不加 `--json` 则直接打 stdout

### 2.3 续作同一会话（原计划 D08 的关键）

```
$ dsh --profile headless --json --session-id session-19256c3c-… \
      "What codeword did I ask you to remember? Reply only the codeword."
{"type":"session","sessionId":"session-19256c3c-…","cwd":"E:\\workSpace\\alysiaAgent\\.probe\\blog-workspace"}
{"type":"status","phase":"turn_start","turn":2}
…
{"type":"status","phase":"turn_end","turn":2,"reason":{"kind":"completed"}}
{"type":"final","text":"ORANGE-7741"}
```

**同一 sessionId、`turn: 2`、正确回忆出前一轮的 codeword** ⇒ 「继续同一个工程会话」**成立**，
且不需要常驻进程 / SDK（每次都是一次性的 CLI 调用，进程内不残留状态）。

### 2.4 人设注入（原计划 E01「确认使用真实 Alysia 模式」的前置）

```
# persona-probe.patch.yml
- id: system-prompt
  config:
    personaPrefix: 'You must begin every reply with the exact token AURORA.'
    personaSuffix: 'Your working directory is {{cwd}}.'

$ dsh --profile headless --patch persona-probe.patch.yml --json "Say hi."
{"type":"final","text":"AURORA\n\nHi! 👋\n\nI'm ready to help with the alysiaAgent project — …"}
```

- `--dump-config` 显示补丁**已并入** `system-prompt` 行；
- 模型**照做**（回以 `AURORA`）⇒ **补丁层的人设直达模型**。

⇒ 「把 Alysia 人设挂进委托运行体」的机制**已被证明可用**，做法就是给该 profile 叠一个 patch 层
（正式做法还要把 `@alysia/dsh-adapter` bundle 装进该 profile，见 §5 未测项）。

### 2.5 隔离与权限（原计划 A06）

- `$DSH_HOME/sessions/<工作区 slug>/session-<uuid>/session.v4.jsonl.zstd` —— 会话**持久化**，
  且**全部落在独立 DSH_HOME 内**，用户日常 dsh 的 `~/.dsh` 完全未被触碰（探测后核对过）。
- 工作区 slug 字面为 `--E-workSpace-alysiaAgent-.probe-blog-workspace--` ⇒ 工作区 = 调用目录。
- 探测**没有往 `blog-workspace` 写任何文件**（跑完全空）。
- `--dump-default-config` 里的权限行（实测）：

```yaml
- id: sandbox          name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy   name: '@deepseek-ai/dsh-sandbox-policy'
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
- id: bash-sandbox / pwsh-sandbox
- id: approval         name: '@deepseek-ai/dsh-user-approval'
- id: permission       name: '@deepseek-ai/dsh-permission-presets'   # 含 read-only 变体
```

⇒ A06「能限制博客执行环境」**有现成机制**：默认 `workspace-write`，可用 `DSH_PERMISSION_MODE` 收紧。

### 2.6 取消能力

`--help` 无任何 cancel 参数；协议层明确「abandons a turn by closing the runtime process」。
⇒ **不支持**。原计划「不能把『本地不再等待』伪装成『远端已经停止』」的口径成立且必须照做。

## 3. 一处否决：headless **没有** agent preset 名册

实测组合树（`dsh --profile headless --dump-default-config`）+ 源码检索双向确认：

- headless 组合 = `dsh-base` + `dsh-headless`；其中 `system-prompt` 行的人设是**字面量**
  （`You are a coding agent powered by the {{model}} model.`）；
- `agent-presets` 名册行**只存在于 web-app 组合包**（`packages/bundle/web-app/cordis.patch.yml:421`），
  base / headless 里都没有。

⇒ **委托运行体不能「选 `alysia-standard` preset」**。要跑 Alysia 模式，只能**把相同的插件层挂上去**
（`@alysia/dsh-adapter` bundle + 人设 patch）—— 这也解释了为什么「Alysia 模式」在 dsh 里是
**pre-configured 组合**而不是一个可传入的 id。

## 4. 现在可以给出的 A05 接口证据表（实测版）

| 能力 | 真实入口 | 输入/输出 | 证据 | 结论 |
|---|---|---|---|---|
| 创建工程会话 | `dsh --profile headless --json "<task>"` | NDJSON 首行 `session.sessionId` / `cwd` | §2.2 实测 | ✅ **支持** |
| 选择 Alysia 模式 | ❌ 无 preset 参数；只能把同名插件层挂进该 profile | — | §3 实测 + 源码 | ⚠️ **不支持「按会话选」，支持「按运行体预置」** |
| 设置工作目录 | 调用目录即工作区根；`cwd` 在事件流回显 | 目录路径 | §2.1/§2.5 实测 | ✅ **支持** |
| 提交任务 | 位置参数 / `-` 读 stdin | 任务文本 | §2.1 实测 | ✅ **支持** |
| 查询执行状态 | `--json` 的 `status.phase`（turn/step）+ `usage` | NDJSON | §2.2 实测 | ✅ **支持** |
| 获取结果或产物 | `final.text`（或 stdout） | 文本 | §2.2 实测 | ✅ **支持**（产物文件要自己收） |
| 继续已有会话 | `--session-id session-…` | 会话 id | §2.3 实测（turn 2 通过） | ✅ **支持** |
| 取消任务 | ❌ 无 cancel；只能杀进程 | — | §2.6 实测 | ❌ **不支持** |
| 权限隔离 | `DSH_PERMISSION_MODE`（默认 `workspace-write`） | 模式名 | §2.5 实测 | ✅ **支持** |
| 人设注入 | `--patch <overlay.yml>` 覆盖 `system-prompt` | YAML | §2.4 实测（模型自证） | ✅ **支持** |

## 5. 本次**未测**（不要当成测过）

| 项 | 为什么没测 | 影响 |
|---|---|---|
| `@alysia/dsh-adapter` bundle 装进探测 profile | 要 `dsh plugin … add` → 走 pnpm → 沙箱 `spawn EPERM`；且包 `main` 指向 `dist/`，需先 build | **E01 的「真实 Alysia 模式」还差这一步**（机制已验证，只差装配） |
| alysia adapter 的 `session/disposed` 回传在 headless 里是否触发 | 需要本机 alysia server 在线 + 装好 bundle | 决定「委托会话是否会被结算/进记忆」→ 正是原计划 §八 关心的点 |
| 服务器（Linux）侧能否跑同一套 | 无服务器访问授权；用户尚未放行 | 决定拓扑（服务器 vs 桌面） |
| 越界写入是否真被拒 | 主动尝试越界写会**制造副作用**，与「只读探测」冲突；只核了组合配置 | A06 的「证明」还差一次受控尝试 |
| 长任务（真建站）的耗时/成本/内存 | 超出本轮范围 | 影响预算与并发设定 |

## 6. 顺带查实的第二条证据：**桌面端正在跑的 dsh-adapter 是旧构建**

原计划 R06 写着「不因为文档写『已归档』就认定已部署」。探测时顺手核了一次**插件侧**，结果坐实：

| 检查项 | `packages/dsh-adapter/src/`（源） | `packages/dsh-adapter/dist/`（**dsh 实际加载的那份**） |
|---|---|---|
| 构建时间 | 2026-10-16 22:47（最新） | **2026-10-02 23:36**（全部文件） |
| `delivery`（KI-24 串行化/结算等待） | 有（`delivery.ts`） | **0 命中** |
| `permanent` / `unreachable`（失败分类） | 有 | **0 命中** |
| `sessionIdOf()` 取不到 id 时 | 返回 `null` + 限频诊断（KI-23 修复） | 仍返回字面量 **`'unknown'`** |

**结论**：`fix-dsh-ingest-and-settlement`（KI-23 / KI-24 / 分批投递）**在源码里、在归档目录里，
但不在正在运行的那份构建里**。桌面 profile 的 `@alysia/dsh-adapter` 是 `link:` 到本包的，
而 dsh 加载的是 `main → ./dist/index.js` —— **没 build 就等于没修**。

> 这条同时说明：原计划的阶段 B 应当**整体改写为「部署/构建核对」**（服务端镜像 + 插件 dist 两端都要核），
> 而不是「修复」。它也正是 HANDOFF 里那句「已归档 ≠ 已部署」的第三次复现
> （前两次：线上镜像落后 HEAD 6 天；`.agent-presets` 与 spec 的说法冲突）。

顺带：探测当时 **`127.0.0.1:6185` 没有服务在监听**（本机 alysia server 未起），
所以桌面 dsh 的桥接调用此刻是「静默 best-effort 失败」——这也解释了为什么这类问题不容易被察觉。

## 7. 探测区与清理

- 位置：`E:\workSpace\alysiaAgent\.probe\`（`dsh-cli` / `dsh-home` / `blog-workspace` / npm-cache / *.out|json）
- 已加 `.gitignore`（`.probe/`），不影响 `git status`。
- 清理：`Remove-Item -Recurse -Force E:\workSpace\alysiaAgent\.probe`（**注意里面有复制来的凭据文件副本**，
  删干净；它没有离开本机）。
- 用户的 `~/.dsh`、本仓代码、服务器：**全程未改动**。
