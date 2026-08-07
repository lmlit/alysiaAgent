# Spec 变更: proactive-messages §2.1.6 问候调度（CR 修复语义补充）

> apply 用——变更行用 `+` 标记。归档时合并回 `openspec/specs/proactive-messages/spec.md`。

### 2.1.6 问候调度（2026-08-08，change: proactive-greeting-context / -scheduler-fixes）

- 精确到点：9:00:00 / 12:30:00 / 21:30:00 触发（原 30min tick 导致 09:29 才发早安）
- 单遍扫描（scheduleNextGreeting，CR 修复 8-08）：DAILY_GREETINGS 时间升序——
  ① 窗口期（当前小时已到且未发未放弃）→ 立即/短延迟补发（重启恢复）；
  ② 未来候选（升序第一个 delay>0）→ 排到点；③ 已过时段跳过；全过 → 明天最早时段
+ - 重启补发：窗口期（hour 已到且 minutes >= g.minute）内未发 → 立即补发（消除"5s 死区"——
+   8:59:57 启动不再丢早安；"同小时候选被推明天"的误伤已消除——12:15 重启排今天 12:30）
+ - 失败重试：sendProactive false **或抛异常**均走重试预算（最多 2 次、10min 间隔；达上限保留
+   计数 ≥3 → 补发跳过，防"失败→补发→失败"热循环；次日新 key 重置）
+ - 守卫（CR 修复 8-08）：① 窗口守卫只查 hour（sleep/时钟后移跨窗口 → 跳过重排，不跨天误发）；
+   ② in-flight 集合防并发双发（sendProactive 挂起 >10min 时重试再入被拦截）；
+   ③ stopped 标志——stop() 后不发送、不 re-arm timer
- 失败重试：sendProactive false → 10min 后重试，最多 2 次（计数仅内存，达上限保留——
  scheduleNextGreeting 补发跳过，防失败→补发→失败循环；重启后由补发兜底）
- tick() 不再处理问候（防双发），只保留节日 + 关怀

（未列行与旧 spec 一致。）
