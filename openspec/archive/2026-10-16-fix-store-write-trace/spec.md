# Spec merge record: fix-store-write-trace

> 本 change **没有**「变更后的完整 spec 全文」可拷贝 —— 它的改动**分散在多个子系统的
> 契约节**里，逐一就地扩写比复制 1000+ 行更不容易出错（且复制出来的"全文"第二天就会过期）。
> 本文件是**合并记录**：说明改到了哪一节、改了什么。

## 合并明细

| 目标 spec | 节 | 内容 |
|---|---|---|
| `openspec/specs/memory-system/spec.md` | **§4.7 存储写入留痕契约** | 标题补记第二刀（change 名 + 日期）；**新增契约 4～10**（见下） |
| `openspec/specs/dsh-adapter/spec.md` | §2.5.1 **契约 9** | 事件重复投递的口径（KI-12 的核心侧实现与本条共同钉住，**由前一个 change 建立、本 change 兑现实现**） |

### §4.7 新增的契约

- **契约 4** —— 0 行「逐点定性」结果表：`ConversationStore.updateSummaryResult`
  已定性为**硬校验**（`rows === 0` 即非成功）。这是**契约 3 第 2 步自己要求回收写**的，
  不是夹带：契约 3 明写「定性结果要写回本条，形成逐点口径表」。
- **契约 5** —— 向量库失败必须可判（`insert`/`delete`/`search`/`count` 报出来；
  `[]`/`0` 不得冒充故障；不可用抛 `VectorStoreUnavailableError`）。KI-14。
- **契约 6** —— 摘要与向量**分别**记账（`SessionEndResult.vectorOutcome` +
  批处理日志的向量总账）。KI-15。
- **契约 7** —— 读兜底不得回写默认值（兜底与回写分离；显式入口才写库且留痕）。KI-16。
- **契约 8** —— 状态默认值必须指向「失败可见」（`summary_status` 写入默认 `'failed'`；
  0 行更新不算成功）。KI-17。
- **契约 9** —— 导入必须原子（doc + 全部 chunk 同事务）、`chunk_count` 用实到块数、
  hash 去重命中必须校验完整性。KI-13。
- **契约 10** —— 裸 `catch` 的处理手法（探测式 / 至少喊一次 / 热路径 `warnThrottled`），
  并列出**不算裸 catch 的两类**（有意的语义回退、幂等跳过）。
  ★ 含一条**核查更正**：`getWorldviewBlock`「永久缓存成空」的旧描述**不成立**
  （callee 永不抛 ⇒ 那个 catch 是死代码；`''` 是 falsy ⇒ 本来就会重试）；
  真正的吞错在 `persona/loader.ts` 的三个读函数，已补 warn。

### 契约 9（dsh-adapter §2.5.1）与本次的关系

事件重复投递的**口径**由 `dsh-adapter` §2.5.1 契约 9 定义（同 id 同内容 = 幂等空转；
同 id 异内容 = 不覆盖 + 响亮报冲突），**核心侧实现**由本 change 的 KI-12 落地。
两处**互相引用**，避免 dsh 侧与核心侧对「重复投递」的理解分叉。

## 未合并项（**刻意**）

- `docs/Web-API-Design.md`：本 change **不新增/不修改任何端点**。
  `summary_status` / `ended_at` 等字段的类型与出现位置不变（取值语义见 §5.4.1 与 §4.7）；
  `MemoryManager.repairPersonaDefaults()` 是**启动期**入口，Web 不需要也不应调用，
  故**有意不登记**进该文档（该文档收录的是 Web 需要的读/写方法）。
- `openspec/specs/index.md` 的 Backlog：`fix-store-write-trace` 随归档移出。
