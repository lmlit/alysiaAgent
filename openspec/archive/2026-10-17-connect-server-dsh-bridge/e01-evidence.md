# E01 执行记录：委托运行体连通验证（2026-10-17）

> change：`connect-server-dsh-bridge`（T4 / T5）
> 执行环境：服务器 `root@<server>`（阿里云北京；**地址不入库**，见 `docs/Docker-Deployment.md`）
> 方式：本地写脚本 → `ssh ... bash -s < script`（避免 PowerShell 破坏远端引号，见 HANDOFF 教训）
> 影响面：只碰**新建**的 profile `alysia` 与**新建**的空工作区 `/root/alysia-blog`；
> **未**动 `web` / `headless` profile、**未**动 `alysia-server` 容器、**未**动 `/root/alysia/data/`。

---

## 0. ★ 首先记录一次**本人的操作失误**（凭据外泄到会话记录）

在 E01 的第一版脚本里我写了这样一行：

```bash
echo "... ${DEEPSEEK_API_KEY:+是}${DEEPSEEK_API_KEY:-否} ..."
```

意图是「设置过就打印『是』」，但 `${VAR:-default}` 的语义是**取变量的值**（不存在才用 `default`）
⇒ **把 `/root/.dsh-web.env` 里的 DeepSeek API Key 明文打进了输出**，
也就进了本次会话记录。这与本仓两次历史事故（8-28 密码进脚本暴露 28 天）**同一类型**。

**已做**：脚本改为只报告「有没有载入」，绝不打印值。
**待办（建议用户执行）**：**轮换该 DeepSeek API Key**，并更新 `/root/.dsh-web.env`。
未执行轮换前，该 key 应视为已暴露。

教训（值得写进纪律）：**「有没有配」的判据必须用 `[ -n "$VAR" ]`，
绝不能用参数展开的 `:-` / `:+` 顺手把值带出来。**

---

## 1. 装配结果

| 项 | 结果 |
|---|---|
| profile | `/root/.dsh/profiles/alysia/`（**新建**） |
| bundles | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless` + **`@alysia/dsh-adapter`**（安装时**自动**并入） |
| 包来源 | `file:/root/alysia-dsh-adapter-0.1.0.tgz`（本地 `npm pack` 后上传；sha256 双边一致 `a3f3bb8a…`） |
| 依赖安装 | `dsh plugin --profile alysia add <tgz>` → pnpm 1.8s 完成，**未触碰** web/headless |
| 回滚 | `rm -rf /root/.dsh/profiles/alysia /root/alysia-blog /root/alysia-dsh-adapter-0.1.0.tgz` |

### 1.1 一个非平凡发现：**adapter 是 bundle ⇒ 它的 patch 会自己叠一层**

`@alysia/dsh-adapter` 的 `package.json` 声明了 `dsh.bundle.patch`，
所以 `dsh.profile.bundles` 里一列它，它**自带的 `cordis.patch.yml` 就会作为独立层叠加** ——
里面已经包含 `alysia-persona`（host 行，基址写死 **6185**）与 `preset-alysia-standard`。

第一版 profile patch 用 `insert` 又加了一条同名 `alysia-persona` ⇒ **组合树里出现两条**，
且一条还指着连不通的 6185。正确做法是：

| 目的 | 正确写法 |
|---|---|
| 改基址 / 加 token | **按 id 覆写** bundle 那条（`- id: alysia-persona` + 完整 config） |
| headless 里没有 `agentPresets` 服务 | 把 `preset-alysia-standard` **`disabled: true`**（否则每次跑都报 `pending` 警告） |
| preset 被禁用后 adapter 行随之消失 | 顶层自己 `insert` 一条 `@alysia/dsh-adapter` |

修正后自检：`alysia-persona` 顶层行数 = **1**。

## 2. 鉴权契约（直接实测，**决定性证据**）

```
/api/health                no-token  -> 200          （豁免，符合设计）
/api/persona/prompt        no-token  -> 401
                           with-token-> 200   正文 16348 字节
/api/memory/read (POST)    no-token  -> 401
                           with-token-> 200   正文  8846 字节
```

⇒ alysia 在服务器上**确实强制鉴权**，而 `AlysiaClient` 原本不带鉴权头。
**本 change 的 T1（Bearer token 支持）是「桥接能不能用」的硬前提**，不是可选优化。

## 3. E01 运行结果（两次一次性任务，均 exit 0）

| 组 | 条件 | 结果 |
|---|---|---|
| A | **不给** `ALYSIA_WEBUI_TOKEN` | 完成；回复「我在这儿，准备好了。」 |
| B | **给出** token | 完成；回复「人家是昔涟——这段身份文字不来自工作目录（`/root/alysia-blog` 现在是空的呢），而是来自注入在我系统提示里的 persona 文件：`soul.md`（人格核心）和 `identity.md`（职位定义），公共底色则取自 `worldview.md`。」 |

**B 组为何算证据**：静态兜底常量（`src/persona.ts`）只有 **417 字符**，
且 `soul.md` 只出现在该文件的**注释**里（不会进模型）；
而 `soul.md` / `identity.md` / `worldview.md` 正是**服务端 16,348 字节人设**里的内容。
⇒ 模型看到的**不是**兜底文本，而是从 alysia 拉来的动态人设。

（`--json` 首行同时给出 `sessionId` 与 `cwd`：`session-*` / `/root/alysia-blog`。）

## 4. 无副作用验证

```
===== 工作区（跑前） =====   /root/alysia-blog
===== 工作区（跑后） =====   /root/alysia-blog
```

**前后逐字一致**，两次任务**未创建/修改/删除任何文件**；
会话落盘在 `/root/.dsh/sessions/--root-alysia-blog--/`（4 个 session 目录）。

## 5. ✅ 已补上：headless 形态的日志可观测性（原缺口）

### 5.1 根因（不是「日志级别不够」，是**根本没有出口**）

读 cordis 源码（`vendor/cordis/src/logger.ts`）得到确切机制：

- `LoggerService` 启动时**只注册一个内存环形缓冲 exporter**（`bufferSize = 1000`，`export` 只往数组里塞，**从不打印**）；
- 真正往终端打印的是**另一个独立插件** `@deepseek-ai/cordis-plugin-logger-console`，行 id `logger-console`；
- 而 dsh 的 **base / headless / web-app 三个组合包都不含这一行**（实测 `--dump-config` 里没有任何 logger 行）。

⇒ `ctx.logger.info/warn()` 的记录**进了内存就没人看**。
这不是本 adapter 的问题，是**任何** dsh 插件在这个发行版里的共同处境。

### 5.2 为什么不能直接装官方那个 exporter

官方 `ConsoleExporter.export()` 里是 **`console.log`（= stdout）**，
而委托运行体的 stdout 是**机器契约**：`--json` 时是 NDJSON 事件流，不带 `--json` 时是最终答案本身。
混进日志行会**破坏解析**（dsh 自己的 `dsh-sdk-jsonrpc-server` 文档把这条写得很硬：
"Stdout carries only JSON-RPC frames… must not compose a stdout logger"）。

### 5.3 做法：`@alysia/dsh-adapter/stderr-log`

新增 `src/stderr-log.ts`（+ 9 条单测）——同一套 exporter API，出口换成 **stderr**：

```yaml
- insert:
    - id: alysia-log-stderr
      name: '@alysia/dsh-adapter/stderr-log'
      config:
        levels: { default: 2 }   # ERROR=0 / INFO=1 / WARN=2 / DEBUG=3（判据是**上限**）
```

### 5.4 验收（服务器实测，stdout / stderr 分开落盘）

```
--- stdout：NDJSON 逐行可解析，零污染 ---
lines=8   NDJSON 可解析行=8 坏行=0   stdout 里被日志污染的行=0
"type":"final","text":"STDOUT-PURITY-OK"

--- stderr：原来一条都看不到的诊断，现在全在 ---
[alysia-log-stderr] exporter 已注册（stderr）· levels={"default":2}
[alysia-persona] 人设变量已注册：persona=xilian · alysia=http://127.0.0.1:6186
[alysia-adapter] 已挂载（记忆 context + recall_memory + 会话钩子）
[alysia-persona] 人设已更新（6375 字）          ← ★ E01 缺的那条决定性证据
[alysia-adapter] session/event user/message
[alysia-adapter] session/event assistant/message
```

**`人设已更新（6375 字）` 正是本文件初版记「未取得」的那条判据**：它是 adapter 拉到动态人设后打的日志，
与 `GET /api/persona/prompt` 的 200 响应互相印证（紧凑人设 6375 字，
与 spec §2.1 记的「0 字 → 6375 字」同一量级）。
同时 `session/event user/assistant` 两行证明**回传钩子确实在触发**（事件正在送进 alysia）。

> ⚠️ 一处无害的观感问题：日志里 logger 名出现两次
> （`[alysia-persona] [alysia-persona] …`）—— 因为 adapter 的日志正文里本来就写了 `[...]` 前缀，
> 而 cordis 也会加上 logger 名。**只是噪声，不影响判据**，未改（改它要动多处调用点，不值得夹带）。

## 6. 结论

| 待验项 | 结论 |
|---|---|
| 委托运行体能否在服务器上起来 | ✅ 能（独立 profile，一次性进程，不监听端口） |
| 工作区是否受控 | ✅ `cwd` = 调用目录，且事件流回显 |
| 是否真的用上了 Alysia 人设 | ✅ 是（HTTP 200 + 16KB 动态人设；`人设已更新（6375 字）` 日志；回答内容印证） |
| 是否有副作用 | ✅ 无（工作区前后一致） |
| 是否影响生产 | ✅ 未触碰运行中的 web profile / 容器 / 记忆数据 |
| 鉴权是否必需 | ✅ 必需（401 vs 200 直测） |
| 日志可观测性 | ✅ **已解决**（`stderr-log` exporter；stdout 零污染，stdout/stderr 分离验收） |
| 回传钩子是否触发 | ✅ 是（`session/event user|assistant` 日志）；**但它是否「该被学习」仍未处理** |

## 7. 下一步（不在本 change 内）

1. 🔴 **轮换泄露的 API Key**（见 §0）。
2. 记忆来源隔离（计划 D10）：委托会话不该被当用户发言学习 ——
   §6 最后一行说明回传**确实在发生**，所以这条现在是**明确的风险**而非假设。
3. 任务表 / 提交工具 / 状态同步 / 继续工程会话（计划阶段 C/D）。
