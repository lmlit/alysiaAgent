# Change Proposal: fix-memory-knob-regression

## 元信息

- **日期**: 2026-10-20
- **类型**: FIX（**B 类：行为必变**，安全性修复）
- **状态**: `applied`
- **影响 spec**: `memory-system` §4.3「记忆人格联动 (v2)」
- **用户授权**: 「AB 都做吧」（B4 = 人格联动 v2）

## 查证结果：v2 其实已经**接了一半**

`PersonaAdapter.applyToParam` 早就在处理 `memory.*`，`regressIfStale` 也覆盖了记忆旋钮。
所以 B4 不是"从零实现"，是**修两个真实缺陷** —— 而它们都源于「共用了别人的默认假设」。

## 缺陷 1：24h 回归的目标是 0，而记忆旋钮的默认值不是 0

旧实现：`regressIfStale` 一律朝 `0` 挪 0.05。对人格参数（`tone.warmth` 等）这是对的（0 = 中性）。

但记忆旋钮的默认值在 `DEFAULT_MEMORY_CONFIG` 里：

| 旋钮 | 默认 | 回归到 0 的含义 |
|---|---|---|
| `decay_rate` | 0.3 | **永不遗忘**（语义 0 = 不忘） |
| `importance_threshold` | 0.4 | **什么都记** |
| `retention_bias` | 0.2 | 丢掉"微微偏向正面" |
| `recency_weight` | 0.3 | 完全不念旧 |

所以"24 小时后回到默认"实际是**单向漂移**：每 stale 一次往极端挪 0.05，**没有界线**。
它与"回归"这个词的语义正好相反。

修法：按**分段**回归（`gap = current - target` 决定方向），人格目标 0、旋钮目标各自默认值。

## 缺陷 2：记忆旋钮被通用 `clamp(-1, 1)` 钳制，能变成负数

`decay_rate = -0.4` 无定义；下游只有个别地方 `Math.max(decay_rate, 0.05)` 兜了一下，
别处照吃负值（例如 `importance_threshold` 为负 ⇒ 什么都能过阈值 ⇒ 加分分支恒真）。

修法：`MEMORY_KNOB_BOUNDS` 按各自值域钳制
（`retention_bias [-1,1]` 双向，其余 `[0,1]`）。

## 不做什么（明确记录）

**`processSignal` 只应用 `adjustments[0]`** —— 模型同时给「人格 + 记忆」两条时第二条被丢。
修它要把返回值从单条改成数组，并让 `apply` 串行过护栏；改动面跨 MemoryManager 与 6 个测试。
**记进 spec 的「已知限制」**，不在本次假装解决。

## 测试（5 条）

- 回归目标是默认值：`decay_rate` 从 0.5 回落且**不越过 0.3**
- 低于默认值时**向上**回归（旧实现只会一路向下）
- `decay_rate` 不会被调成负数
- `retention_bias` 允许负向（双向值域）
- 人格参数仍回归到 0（原语义未被破坏）

## 回滚

两处都是局部逻辑：`regressIfStale` 的目标表达式与 `MEMORY_KNOB_BOUNDS`。
回滚 = 恢复「目标恒 0 + 通用 clamp」，但那会把两个 bug 一起还回去。

## 对账方向

spec 早就写着「与 tone/speech/emotional **共用同一护栏机制**」。
共用是事实，但**共用的默认假设是错的**（旋钮默认≠0）⇒
**改 impl**（回归目标按参数族分开），并把这条契约**写明**，防止下次又"顺手共用一下"。
