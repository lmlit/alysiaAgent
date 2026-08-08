---
status: active
source: docs/superpowers/specs/2026-08-02-proactive-messages.md
migrated: 2026-08-07
---
# 主动消息系统 — 设计文档

> 日期: 2026-08-02
> 状态: 已实现
> 前置: QQ 官方 Agent 适配器（sendProactive）

---

## 1. 背景与目标

### 1.1 需求

- **时段问候**：早/午/晚固定时间给 owner 发问候
- **节日祝福**：公历节日 + 农历节日 + 二十四节气
- **主动关怀**：长期未聊的活跃私聊 → 主动问候
- **提醒推送**：用户设置的定时提醒到点 → 主动推送给设置者

### 1.2 平台约束（实测）

QQ 官方 API 私聊互动窗口（48h）内主动消息可用（已实测验证）。超出窗口会被拒。

---

## 2. 架构

```
ProactiveService (server/src/proactive.ts)
├── greetingScheduler — 时段问候独立调度器（精确到点 hour:minute 触发，不依赖 30min tick）
│   ├── scheduleNextGreeting() — 计算下一次问候 → setTimeout 到点 fireGreeting()
│   ├── fireGreeting(hour, minute) — 去重 → 上下文注入 → personalize → sendProactive
│   │    失败重试：最多 2 次、间隔 10min；重启补发：窗口期内未发立即发
│   └── contextSnippet() — 问候上下文素材（用户近况 + 今天生活事件 + 亲密度）
├── tick() — 每 30 分钟跑一次（启动时立即跑一次）
│   ├── 1. 节日祝福（当天一次：公历 + 节气 + 农历映射）
│   └── 2. 主动关怀（owner 私聊，≥3 条消息、≥24h 未聊、当天未关怀；文案走 personalize）
└── personalize(fallback, context) — LLM 个性化文案，失败回落写死文案
```

### 2.1 去重机制（内存 Set/Map + 文件持久化）

- `sentGreetings`：日期+时段
- `sentFestivals`：日期
- `lastCareByUser`：openid → 日期
- **持久化（已实现）**：stateFile（`data/proactive-state.json`），变更防抖 1s 落盘 + 停止时 flush；
  重启后当天问候/祝福不重复发（2026-08-02 实现，原待办已销）

### 2.1.5 问候上下文注入（2026-08-08，change: proactive-greeting-context）

问候的 LLM 上下文（原只有时段描述）注入三样素材，全部静默容错（素材缺失不阻塞发送）：

- 用户近况：`getUserActivitySummary()`（如"昨天聊到在玩老头环"）
- 今天生活事件：`listLifeEvents(1)` 过滤当天最新 3 条（AI 自己今天在做什么）
  （8-08 修正：入参是天数——取最近 1 天即完整覆盖今天；旧 2 天窗口语义含糊）
- 亲密度：`getLifeSnapshot().intimacy/100`

prompt 注明"用于让问候更自然贴切，不要生硬引用"——防贴标签式文案。
动机：8-07 云端日志实测问候生成通用模板级文案（无个性化素材），对比 LifeService woke prompt。

### 2.1.6 问候调度（2026-08-08，change: proactive-greeting-context / -scheduler-fixes）

- 精确到点：9:00:00 / 12:30:00 / 21:30:00 触发（原 30min tick 导致 09:29 才发早安）
- **单遍扫描**（scheduleNextGreeting，CR 修复 8-08）：DAILY_GREETINGS 时间升序——
  ① 窗口期（当前小时已到且未发未放弃）→ 立即/短延迟补发（重启恢复）；
  ② 未来候选（升序第一个 delay>0）→ 排到点；③ 已过时段跳过；全过 → 明天最早时段
- 重启补发：窗口期（hour 已到且 minutes>=g.minute）内未发 → 立即补发。
  **CR 修复**：无"5s 死区"（8:59:57 启动不丢早安）、无"同小时候选被推明天"误伤（12:15 重启排今天 12:30）
- 失败重试：sendProactive **false 或抛异常**均走重试预算（最多 2 次、10min 间隔；达上限保留计数
  ≥3 → 补发跳过，防"失败→补发→失败"热循环；次日新 key 重置）
- 守卫（CR 修复 8-08）：① 窗口守卫只查 hour（sleep/时钟后移跨窗口 → 跳过重排，不跨天误发）；
  ② in-flight 集合防并发双发（sendProactive 挂起 >10min 时重试再入被拦截）；
  ③ stopped 标志——stop() 后不发送、不 re-arm timer
- tick() 不再处理问候（防双发），只保留节日 + 关怀

### 2.2 LLM 个性化（bootstrap 注入 generateText）

- systemPrompt 固定：以昔涟身份生成 30-60 字问候/祝福，只输出内容
- sessionId 固定 `'proactive'`（独立会话）
- 失败/空 → 回退写死文案；发送日志只打 sent/failed 不打内容
- **主动关怀同走 personalize**（8-08，原写死池子随机取、与问候/祝福不一致）：
  prompt 强调"轻量、不追问、不制造回复压力"；失败回落 CARE_MESSAGES 池
- 日志统一 `[Proactive]` 前缀：`[Proactive] greeting 9:0: sent` / `[Proactive] festival "立秋": sent` /
  `[Proactive] care → xxxx: sent`（2026-08-08 统一，原发送日志无前缀难 grep）

---

## 3. 数据表（写死常量，非 DB）

| 表 | 内容 | 数量 |
|----|------|------|
| DAILY_GREETINGS | 时段问候 | 3（9:00/12:30/21:30） |
| FESTIVALS | 公历节日 | 9（元旦/情人节/妇女节/劳动节/儿童节/教师节/国庆/平安夜/圣诞） |
| SOLAR_TERMS | 二十四节气 | 24（2026 精确公历日期，±1 天浮动） |
| LUNAR_FESTIVALS | 农历节日定义 | 6（春节/元宵/端午/七夕/中秋/重阳） |
| LUNAR_FESTIVAL_DATES | 农历→公历映射 | 2026-2028（年份缺失不触发） |
| CARE_MESSAGES | 关怀文案池 | 4（随机取） |

---

## 4. 提醒推送链路

```
reminder 工具（core/tools/reminder.ts）
  └─ 设置时记录 sessionId
     └─ 到点 notifyFn(text, sessionId)（bootstrap 注册）
        └─ sessionId 解析 openid（:private:private_(.+)$）
           └─ qqOff.sendProactive(openid, `⏰ ${text}`)
              └─ 日志: Reminder push → xxxx: sent/failed
```

非私聊会话提醒只打日志不推送。

---

## 5. 时区约定

全部使用**本地时间**（UTC+8，服务器运行环境一致）：`getHours()/getMinutes()` 判断时段，`getMonth()/getDate()` 判断节日。Docker 部署需 TZ=Asia/Shanghai。

---

## 6. 待办

- [x] 去重状态持久化（重启后当天问候会重复发）→ 已实现（stateFile，2026-08-02）
- [ ] 发送内容记日志（当前只记 sent/failed）
- [ ] 关怀范围扩展到 owner 之外（需谨慎：骚扰风险）
