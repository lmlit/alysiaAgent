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
├── tick() — 每 30 分钟跑一次（启动时立即跑一次）
│   ├── 0. 时段问候（9:00 / 12:30 / 21:30，每天各一次）
│   ├── 1. 节日祝福（当天一次：公历 + 节气 + 农历映射）
│   └── 2. 主动关怀（owner 私聊，≥3 条消息、≥24h 未聊、当天未关怀）
└── personalize(fallback, context) — LLM 个性化文案，失败回落写死文案
```

### 2.1 去重机制（内存 Set/Map + 文件持久化）

- `sentGreetings`：日期+时段
- `sentFestivals`：日期
- `lastCareByUser`：openid → 日期
- **持久化（已实现）**：stateFile（`data/proactive-state.json`），变更防抖 1s 落盘 + 停止时 flush；
  重启后当天问候/祝福不重复发（2026-08-02 实现，原待办已销）

### 2.2 LLM 个性化（bootstrap 注入 generateText）

- systemPrompt 固定：以昔涟身份生成 30-60 字问候/祝福，只输出内容
- sessionId 固定 `'proactive'`（独立会话）
- 失败/空 → 回退写死文案；发送日志只打 sent/failed 不打内容

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
