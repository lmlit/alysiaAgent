# Tasks: gate-project-tasks-to-offpeak

> **状态（2026-10-18）**：T1–T6 完成，真机双向验证（拦得住 + 会自己开跑）。

## 实现

- [x] **T1 纯函数** `packages/core/src/memory/project-task-window.ts`
      - `computeTaskWindow({ now?, holidays?, peakWindows? })` → `{offPeak, reason, nowBeijing, until?, message}`
      - 时区**自己算 UTC+8**（不看宿主）；高峰窗口左闭右开
      - 判定顺序：周末 → 节假日 → 高峰窗口 → 其余空闲
- [x] **T2 core 接线**：`MemoryManager` 不动；barrel 导出供服务端与工具共用同一份规则；
      `AlysiaCoreOptions.projectTasks` → `toolsModule.taskWindow` → `createProjectTaskTools`
- [x] **T3 路由闸门**：`/next` 高峰返回 `paused`（**不认领**）；新增只读 `/window`
- [x] **T4 工具回执**：高峰提交仍收下，回执带"高峰 … 几点之后 … **不用再交一次**"
- [x] **T5 配置**：`projectTasks.{holidays,peakWindows,nowOverride}` + `sanitizeProjectTasks()`
      + **`loadConfig()` 显式映射**（这个坑踩过：只加类型不加映射 ⇒ 配置被静默丢弃）
- [x] **T6 runner**：识别 `paused`，只在说法变化时打一行（不刷屏）

## 测试

- [x] 窗口纯函数 **29 条**（边界 9:00/12:00/14:00/18:00、周末、节假日、UTC↔北京、跨日、窗口覆盖）
- [x] 路由 **+5**（高峰不认领、午休认领、节假日认领、周末认领、`/window` 依据、`nowOverride`）
- [x] 工具 **+3**（高峰带提示、空闲不带、周末不带）
- [x] 全仓 **119 文件 / 1468 用例** 绿

## 真机验证（生产，双向）

**固定时钟到 2026-10-19（周一）10:15：**

```
GET /api/project-tasks/window →
  offPeak=False reason=peak until=2026-10-19T04:00:00.000Z
  msg= 现在是高峰时段（2026-10-19 10:15，工作日 09:00–12:00），
       这件活要等到 12:00 之后（北京时间）才会开始跑 —— 到点自己会跑，不用再交一次。

建任务 → t+15s/30s/45s/60s 全部 queued（没被认领）
runner 日志（**只一行**）：
  ⏸ 暂停认领（高峰时段）：现在是高峰时段（…）…不用再交一次。
```

**删掉 override（回到真实时间）：**

```
t+15s needs_review    final=GATE-OK
runner: 认领到 pt-885c9210-…（revision 0，第 1 次）
```

⇒ **拦得住、也会自己开跑**；暂停日志确实只打一次。

## 过程中的两次自我纠错（记在案）

1. **第一次真机测试完全无效**：服务器 py3.6 的 PyYAML 不支持 `safe_dump(sort_keys=…)`，
   配置没写成，紧接着容器重启期间 POST 全失败 → 结果是"任务照跑"，看起来像闸门失效。
   ⇒ 改成**只追加一段 YAML**（不改写整份配置，保住注释）+ 创建请求带重试。
2. **第二次仍然无效**：部署上去的是**旧镜像**（容器里 `grep project-tasks/window` = 0）。
   ⇒ 现在部署脚本**load 完立刻验标记**，不通过就中止，绝不在旧镜像上做实验。

⚠️ 还有一条容易误判的事实：**2026-10-18 是周日**，周末判定在高峰之前短路 ⇒
当天无论怎么配窗口都不会进 peak。所以真机验证必须能固定时钟（`nowOverride`）。

## 未做

- [ ] 节假日表**仍是空的**（需要真实数据；不敢猜）
- [ ] 未做"按价格自动切换模型/降级"
- [ ] 未做跨时区日历（她用北京时区，没有第二个）
