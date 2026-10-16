# Tasks: filter-synthetic-context-inflow

> ⚠️ 本 change **只完成了取证（R1）**，实现（R2 起）**尚未动手**。
> 取证结论：**dsh 合成注入 ⇒ 该滤**。

## R1 取证 ✅ 完成

### 取证记录（结论 + 原始证据，按 proposal 第 4 条要求）

**问题**：KI-20 的注意项 —— 那段 `Current runtime context. …` 是
**dsh 合成注入**还是**真实用户输入**？（前者才该滤）

**结论**：**dsh 合成注入。不是真实用户输入。**

**证据 A（第一手观察，2026-10-16，本会话）**

dsh **当前版本**在本轮对话里注入了一段，开头逐字为：

```
Current runtime context. This snapshot supersedes earlier runtime-context snapshots.
```

其后跟的 `body` 是：**「Current DSH file policy: …」与「Approval prompts are disabled …」**
—— 与用户发言**完全无关**（讲的是沙箱模式与审批开关）。

★ 这条观察本身就说明：**同一条前缀下 body 的内容可以是任意会话配置**。

**证据 B（决定性：产它的代码）**

在 dsh 自己的产物 `E:\dsh\resources\app.asar`（121,348,951 bytes）里搜该字符串：

```
命中次数: 1
```

命中行**全文**（106 字符）：

```js
	return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`;
```

**前缀是 dsh 的字面量，`body` 是变量** ⇒ 这是 dsh 的一个**包裹函数**：
把任意 `body` 包上前缀后注入会话。

**由证据推出的机制（解释得通那 116 条）**

1. 前缀既然由 dsh 产生，事件开头就与用户发言无关；
2. 注入的是会话里的**一条 user 角色消息** ⇒ adapter 的「用户消息」监听器
   **照样会捕获并回传** ⇒ 所以**主会话也有**（不是子 agent 专属），
   且单个会话（`dsh:session-29b9865c`）能出现 **35 次**；
3. 生产里那些事件的 body 是 `[角色设定]`/`[关于你]`/`[关于我]`
   —— 正是 **alysia 自己注入的上下文**，被 dsh 连前缀一起当成用户消息回灌 ⇒
   这就是「画像回吸 / 记忆触发记忆」两条自指回路的样子。

**复现步骤**（不碰任何用户数据，将来可复核）

```powershell
$f='E:\dsh\resources\app.asar'
Select-String -Path $f -Pattern 'supersedes earlier runtime-context' -Encoding utf8
```

**⚠️ 证据的边界（不许越读）**

- 我验证的是**前缀的产生者**，**不是**那 116 条生产事件的完整 payload 形态。
  它们的 body 属**间接**证据（那些块本就是 alysia 注入的）。
- `body` 是变量 ⇒ 过滤必须**按"前缀包裹"整体判定**，不得假设 body 长什么样、
  更不得把 body 当她的发言去学习。

### 取证带来的两个影响

- **R3 更站得住了**：前缀是 dsh 的**字面量**，改文案就失效 ⇒
  主判据仍应是**事件类型与来源标记**，前缀只作兜底（与 proposal R3 一致）。
- **D2（存量数据不在本 change 处理）不变**：116 条事件与由它们产出的 facts
  仍需单独的数据修复方案。

## R2–R6 实现 ✅ 完成（2026-10-16）

- [x] **R2 拦截**：合成内容不作为普通用户发言参与画像 / 人格 / 嵌入
      （复用既有 `skip_profile` 闸，`RealtimeProcessor` + `ProfileExtractor` 都遵守）
- [x] **R3 判据用结构化来源**：`data.message.source.kind === 'runtime-context'`
      （适配器透传 → 服务端判定）
- [x] **R4 区分「入库」与「进学习管道」**：事件照常入库，`dsh_source` 作为证据留在 payload 里
- [x] **R5 可观测**：跳过留痕（限频，键按事件类型）
- [x] **R6 不误伤真实对话**：结构化判据不认文本，且有用例锁住"用户粘贴同一段文本"

### ⚠️ 落地时**被证据改掉的两处**（与上面原措辞的偏离，必须留档）

1. **文本前缀从"兜底判据"降为"不作判据"**。
   原 R3 写「前缀判据是脆的…只能当兜底」。实现时判定：前缀与 **R6** 直接冲突
   （用户粘贴同一段文本会被误判成合成），而结构化判据**按定义**不会误伤，
   且已被证明覆盖**全部已知样本**（那 116 条都出自同一个 `project()` 调用点，
   而 dsh 自己就是靠 `source.kind` 从**已提交事件**里回溯该快照的）。
   ⇒ **前缀完全不参与判定**。这是**主动收窄**，不是遗漏。
2. **多堵了一条泄漏路径：摘要**（原提案只提画像与人格）。
   实现时读代码发现 `SessionEndProcessor` 用**全部** messageEvents 组 dialogue，
   **不看 `skip_profile`** ⇒ 合成文本会进摘要、日后被召回并回灌。
   已排除 `synthetic`（**只排 synthetic**，不动群聊 NPC 的既有行为）。

### 顺带修掉的一个既有测试缺陷（与本 change 主题相关）

`tests/memory/integration/processors.test.ts` 给 `RealtimeProcessor`（**7 个参数**）
只传了 **6 个** ⇒ `profileExtractor` 拿到 `mockEmbed`、`embedService` 拿到 vectorStore、
`vectorStore` 成了 `undefined`（走"没有向量库"分支），
而 `detectCorrectionSignal` 的 TypeError 被 `RealtimeProcessor` 的 try/catch 吞掉
⇒ **测试一直是绿的，但跑的不是它以为的那条路**。

⚠️ 根因：`tsconfig.json` 是 `include: ["src/**/*.ts"]` —— **测试文件不参与类型检查**，
参数个数不对也不报错。已补上第 5 个参数（该文件 14 例仍全绿）。
**这条纪律值得记住：改测试里的构造调用时，别指望 tsc 拦你。**

## 测试

| 编号 | 落点 | 覆盖 |
|---|---|---|
| S1 | `core/tests/memory/synthetic-inflow.test.ts` | 合成事件**不触发人格扫描**、**不做嵌入**、不标 `PROCESSED_PROFILE` |
| S2 | 同上 | 合成事件**仍在事件表**、内容与 `dsh_source` 原样保留 |
| S3 | 同上 | 跳过**留痕**；**群聊 NPC 的 skip_profile 不被一起打**（回归：别把日志搞吵） |
| S4 | `server/tests/ingest-synthetic.test.ts` | **用户粘贴同一段文本 → 照常学习**（R6 核心）；别的 `source.kind` 也照常 |
| S5 | `dsh-adapter/tests/index.test.ts`（新增 6 例） | 透传 `dsh_source`；合成注入**不触发话题刷新**（真用户消息仍触发）；留痕限频；普通消息不带 `dsh_source` |
| S6 | `core` / `server` / `dsh-adapter` 全量 | 回归不变（见下） |
| S7 | `core/tests/memory/synthetic-inflow.test.ts` | **摘要输入不含合成注入**、含真实对话；全是合成时走 `no-dialogue`（不白调 LLM） |

## Apply 任务

- [x] A.1 取证结论回写 `proposal.md`（含否决项与证据边界）
- [x] A.2 取证记录落本文件（**结论 + 原始证据**，见上）
- [x] A.3 spec 合并：
      - `dsh-adapter` §2.5（**合成注入不算用户发言**：判据表 + 职责分工 + 前缀为何不作判据）
      - `alysia-architecture` **新增 §4.3.1**（「不进学习管道」闸的**通用**契约：三条必须同时成立 + 判据纪律）
- [x] A.4 实现 + 测试（S1–S7）
- [x] A.5 归档
- [x] A.6 更新 `docs/KNOWN-ISSUES.md` KI-20（取证定案 + 两处被证据改掉的决策）

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| core 定向 | `run tests/memory/synthetic-inflow.test.ts`（`packages/core`） | **8 passed** |
| core 全套 | `run --exclude='tests/memory/e2e/*'`（`packages/core`） | **76 files / 750 passed**（本 change 前 75 / 742） |
| server 定向 | `run tests/ingest-synthetic.test.ts`（`packages/server`） | **8 passed** |
| server 全套 | `npx vitest run`（`packages/server`） | **15 files / 251 passed**（前 14 / 243） |
| dsh-adapter 全套 | `npx vitest run`（`packages/dsh-adapter`） | **6 files / 108 passed**（前 6 / 102，+6） |
| 类型 | `npx tsc --noEmit`（core / server / dsh-adapter） | 三者 exit 0 |

## 部署状态

**未部署。**

⚠️ **生效需要两侧都更新**（缺一侧则本修复不完整）：
- **server** 侧：`normalizeIngestEvent` 的判定（新端点行为）；
- **dsh 插件侧**：适配器要能透传 `source.kind` ——
  dsh 侧改动需要**重装插件 bundle**（`install_bundle`），与服务端发布是**两条独立路径**
  （见 `dsh-adapter` §5）。
  ⇒ 只更新服务端、不更新插件：**不会误伤**（判定拿不到 `dsh_source`，行为等同修复前），
     但**也不会生效**。

## 仍未做

- **存量数据修复**：已入库的 116 条事件与由它们产出的 facts
  （`purge-subagent-pollution` 同类工作）——**本 change 明确不做**（proposal D2）。

