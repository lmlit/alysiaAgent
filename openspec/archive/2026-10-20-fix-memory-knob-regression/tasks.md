# Tasks: fix-memory-knob-regression

- [x] 查证：`applyToParam` / `regressIfStale` **早已覆盖** `memory.*` ⇒ B4 是修 bug，不是从零做
- [x] `MEMORY_KNOB_BOUNDS`：`retention_bias [-1,1]`，其余 `[0,1]`
- [x] `applyToParam` 的记忆分支按各自值域钳制（不再用通用 `clamp(-1,1)`）
- [x] `regressIfStale` 按**分段**回归：人格 → 0，旋钮 → `DEFAULT_MEMORY_CONFIG[key]`
- [x] `evidence` 里带上回归目标值（便于事后核对）
- [x] 测试 `persona-memory-knob-regression.test.ts`（5 条）
- [x] 全量：**142 文件 / 1767 测试全绿**
- [x] spec §4.3：补契约 A/B/C + **已知限制**（只应用 `adjustments[0]`）
- [x] 归档 + 索引 + TODO + HANDOFF

## 已知限制（未修，独立 change）

`processSignal` 只应用 `adjustments[0]`：模型同时给出「人格 + 记忆」两条时，**第二条被丢弃**。
修法：返回值改数组 + `apply` 串行过护栏；影响 `MemoryManager` 与 6 个测试。
