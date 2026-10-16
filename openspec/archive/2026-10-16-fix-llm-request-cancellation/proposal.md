# Change Proposal: fix-llm-request-cancellation

## 元信息

- **日期**: 2026-10-16
- **类型**: FIX（修 bug；一处是**资源回收**，一处是**监听泄漏**）
- **状态**: **archived**（2026-10-16 完成 propose → apply → archive；未部署）
- **影响 spec**: `alysia-architecture` §6.1.1（60s 超时语义）与 §6.1.2（流式）
- **来源**: 修复计划「第三批」的「请求取消」项；`docs/CODE_REVIEW_FIX_PLAN-2026-08-29.md` #11 的**仍然成立的那一半**

## 这条要解决什么

两个**独立**缺陷，都在 `provider/openai.ts` 的请求清理上。

### ① 60s 超时**从不 abort 底层请求**（连接/后端不回收）

race 到点只 `reject(...)`：

```ts
timeoutTimer = setTimeout(() => reject(new Error('LLM request timed out (60s)')), 60_000);
```

⇒ race 保证了**准时返回**，但**已建立的连接继续挂着**：
socket 不释放、服务端继续生成（那条 2026-08-12 备注里"实测 566s"讲的就是这个后果）。

★ **这不是"加个 abort 就准时了"**——`llm-request-timeout-race` 已经证明 abort
**到不了** DNS/连接建立阶段。两者**分工不同**，**都要有**：

| 手段 | 保证什么 | 到不了哪 |
|---|---|---|
| `Promise.race` | **准时返回** | —— |
| `controller.abort()` | **回收连接/让后端停** | DNS/连接建立阶段 |

### ② 外部打断信号上的监听**只增不减**

```ts
req.signal.addEventListener('abort', () => controller.abort(), { once: true });
```

`{ once: true }` **只在触发时**才自动摘除。而 `req.signal` 是 **Coalescer 的打断注册表**
那种**长寿命**对象，且**大多数请求是正常跑完的**（永远不会触发 abort）
⇒ **每次请求都在它身上残留一个闭包**，长会话下只增不减。

实测证据（见 tasks.md 的红）：**5 次请求 → 长寿命 signal 上留下 5 个监听**。

## 需求（做什么）

- [ ] **R1**：60s 超时（非流式 + 流式两条路径）**都要 `controller.abort()`**
- [ ] **R2**：⚠️ **不得**用 abort 替代 race —— 准时性只能靠 race（见上表），
      删掉 race 会让 DNS 挂起重新退化成 566s
- [ ] **R3**：外部 signal 的监听必须在请求结束时**显式摘掉**（`finally`，不是可选项）
- [ ] **R4**：外部打断功能**不受影响**（摘监听不能把打断也摘掉）
- [ ] **R5**：清理逻辑**只有一份**：非流式与流式共用同一个 `linkAbort()` helper

## 设计决策（怎么做，含备选与取舍）

### D1 抽 `linkAbort(reqSignal, controller) => cleanup`，两条路径共用

原先两条路径各写了一遍同样的内联 4 行，**两次都漏了摘监听**（同一份错误抄了两遍）。
抽成一个 helper 并**返回清理函数**，把"配对义务"变成签名的一部分 ——
调用方拿到 `unlinkAbort` 就必须在 `finally` 里用掉。

**被否决：只在 `textChat` 修**——流式那条是同一个 bug，留一半等于没修。

### D2 `finally` 里摘监听，而不是"请求成功时摘"

`finally` 覆盖成功、API 错误、超时、外部打断**全部出口**。
写在成功分支里会漏掉错误路径（而错误路径恰恰是长会话里更常见的那些）。

### D3 不引入 `AbortSignal.any()` / `AbortSignal.timeout()`

它们能把两个信号合一个、并自动超时，代码更短，但：
- 会**绕开** `llm-request-timeout-race` 那条来之不易的结论（DNS 阶段不可中断 ⇒
  必须靠 race 保证准时）；
- `AbortSignal.timeout()` 的定时器**不可清理**，与我们显式 `clearTimeout` 的现状不一致。

**记在这里是为了防止后人"顺手简化"把 566s 那个坑重新挖开。**

## 对账方向确认

- [x] 与现有 spec 冲突？——§6.1.1 只写了「race 保证准时返回」，
      **未声明**「超时要回收连接」；§6.1.2 只写了「外部 signal 透传」，
      **未声明**监听的生命周期。本 change **补契约**。
- [x] 方向判断：**缺陷**（行为不对）⇒ **改 impl + 补 doc**。
- [x] 涉及 Web API？——**不涉及**。
- [x] ⚠️ **核对既有 CR**：`CODE_REVIEW_FIX_PLAN-2026-08-29.md` #11 原文是
      「超时命中后从不调 `controller.abort()`」——**前半句今天仍然成立**（本 change 修它），
      但它当时隐含的"加 abort 就能准时"**已被 8-12 的 race 证伪**。
      两者是**不同的目标**，本 change 在契约里把分工写清，避免再被混为一谈。

## 测试计划

落点：`packages/core/tests/provider/openai.test.ts`。

| 编号 | 场景 | 验收 |
|---|---|---|
| A1 | **主症**：fetch 永久挂起 → 推进过 60s | 返回 `Request timed out (60s)`，且**传给 fetch 的 signal `aborted === true`** |
| A2 | **主症**：同一个长寿命 signal 跑 5 次请求 | `getEventListeners(signal,'abort')` **回到请求前的数量**（旧实现是 +5） |
| A3 | 回归：请求结束后外部 abort | **不得**再影响那次已完成的请求 |
| A4 | 回归：请求进行中外部 abort | 照旧返回 `Request aborted` |
| A5 | 回归 | 既有 9 条 provider 用例继续通过 |

## ⚠️ 动手前的提醒

- **别删 race**（R2）——这是本 change 最容易改错的地方。
- **流式路径也要改**（R5）——别只改非流式。
