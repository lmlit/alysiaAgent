# Spec 变更: proactive-messages §2 架构 + §2.2 LLM 个性化

> apply 用——变更行用 `+` 标记。归档时合并回 `openspec/specs/proactive-messages/spec.md`。

## 2. 架构

```
ProactiveService (server/src/proactive.ts)
├── greetingScheduler — 时段问候独立调度器（精确到点 hour:minute 触发，不再依赖 30min tick）
│   ├── scheduleNextGreeting() — 计算下一次问候 → setTimeout 到点 fireGreeting()
│   ├── fireGreeting(hour, minute) — 到点发送（去重 → 上下文注入 → personalize → sendProactive）
│   │    失败重试：同 key 最多 2 次、间隔 10min；重启补发：窗口期内未发立即补发
│   └── contextSnippet() — 问候上下文素材：用户近况 + 今天生活事件 + 亲密度（2026-08-08 优化）
├── tick() — 每 30 分钟跑一次（启动时立即跑一次）
│   ├── 1. 节日祝福（当天一次：公历 + 节气 + 农历映射）
│   └── 2. 主动关怀（owner 私聊，≥3 条消息、≥24h 未聊、当天未关怀）
└── personalize(fallback, context) — LLM 个性化文案，失败回落写死文案
```

+ ### 2.1.5 问候上下文注入（2026-08-08，change: proactive-greeting-context）

+ 问候的 LLM 上下文（原只有时段描述）注入三样素材，全部静默容错（缺失不阻塞发送）：

+ - 用户近况：`getUserActivitySummary()`（如"昨天聊到在玩老头环"）
+ - 今天生活事件：`listLifeEvents()` 当天最新 3 条（AI 自己今天在做什么）
+ - 亲密度：`getLifeSnapshot().intimacy/100`

+ prompt 注明"用于让问候更自然贴切，不要生硬引用"——防贴标签式文案。
+ 动机：8-07 云端日志实测问候生成通用模板级文案（无个性化素材），对比 LifeService woke prompt。

+ ### 2.1.6 问候调度（2026-08-08，change: proactive-greeting-context）

+ - 精确到点：9:00:00 / 12:30:00 / 21:30:00 触发（原 30min tick 导致 09:29 才发早安）
+ - 重启补发：当前时刻处于某问候窗口期（hour===g.hour && minutes>=g.minute）且未发 → 立即补发
+ - 失败重试：sendProactive false → 10min 后重试，同 key 最多 2 次（计数仅内存，重启由补发兜底）
+ - tick() 不再处理问候（防双发），只保留节日 + 关怀

## 2.2 LLM 个性化（bootstrap 注入 generateText）

- systemPrompt 固定：以昔涟身份生成 30-60 字问候/祝福，只输出内容
- sessionId 固定 `'proactive'`（独立会话）
- 失败/空 → 回退写死文案；发送日志只打 sent/failed 不打内容
+ - 日志统一 `[Proactive]` 前缀：`[Proactive] greeting 9:0: sent` / `[Proactive] festival "立秋": sent` /
+   `[Proactive] care → xxxx: sent`（2026-08-08 统一，原发送日志无前缀难 grep）

（未列行与旧 spec 一致。）
