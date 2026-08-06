# AI 主动生活系统 — 设计文档

> 日期: 2026-08-06  
> 状态: 已设计（待实现）  
> 前置: ProactiveService（`packages/server/src/proactive.ts`）、sendProactive（`packages/server/src/adapters/qq-official.ts`）、EventStore、ProfileStore、WorldbookStore

---

## 1. 背景与目标

当前 AI 助手只能被动响应，用户不开口它就沉默，缺乏"生活感"与陪伴感。

**目标**：让 AI 拥有独立的日常事件流，能够主动发起对话、分享自己的"生活"，形成自然的双向陪伴关系。

**核心设计原则**（源自需求文档 v0.1）：

1. **AI 有自己的生活**——不是等用户来聊，而是有自己的日常事件、状态和情绪
2. **主提示词瘦身**——只奠定角色基调，细节由角色画像动态注入（**二期独立做**，本次不动对话主链路）
3. **用户只给框架，内核由 AI 驱动**——事件如何发生、何时开口，由 AI 自主决策

---

## 2. 关键决策（已确认）

| 决策点 | 结论 |
|--------|------|
| 事件库 | 世界书人设背景（采样注入）+ 通用模板 + LLM 自创 |
| 每小时触发概率 | 30%（约每天 5-7 个事件，可调） |
| 主动聊天冷却 | ≥2 小时 |
| 聊天锁 | 30 分钟内有用户互动 → 跳过本轮，下小时再试 |
| 窗口外事件 | 照常生成（生活积累），窗口内尝试推送 |
| 事件时间感知 | 生成器/事件流注入/判定器全部注入当前本地时间 |
| 事件连续性 | 事件可引用历史事件（剧情链），每日摘要生成 |
| 事件存储分层 | 原始事件全量存；注入/引用分层（今天逐条+近7天摘要） |
| 亲密度 | 互动数据自动推导 0-100 |
| 主动消息回写 | 推送成功的消息 ingest 回 EventStore（assistant 角色） |
| 主动消息表情包 | 本次支持（扩展 sendProactive 解析 `[表情包:xxx]`） |
| 主提示词瘦身 | 二期独立立项 |
| 事件注入 prompt | 每次对话注入「[我的近期日常]」块 |

---

## 3. 架构

```
LifeService（新建，每小时 tick，与 ProactiveService 并存）
│
├── ① 事件判定器（决策门，全过才触发）
│      概率 30% → 冷却 ≥2h → 聊天锁（30min 内有互动→跳过）
│      → 深夜(0-7点)强制 type=internal
│
├── ② 事件生成器（LLM，woke 模式）
│      输入: [当前时间] + 当前状态 + 事件回顾(今日逐条+近7天日摘要)
│            + 世界书人设背景(采样N条) + 用户画像 + 亲密度 + 通用模板参考
│      输出: { content, type('chat'|'internal'), mood_delta, reference_event_id? }
│
├── ③ AI 状态机（持久化）
│      current_activity / mood / intimacy（每日摘要独立存摘要表）
│
├── ④ 事件流存储（SQLite 新表 ai_life_events，完整历史）
│
├── ⑤ 亲密度引擎（每小时更新）
│      EventStore 近7天互动频率 / 会话时长 / 用户主动占比 → 0-100
│
└── ⑥ 推送与回写
      chat 事件 + 窗口内 → sendProactive(带表情包解析)
      → 成功后 ingest 回 EventStore（assistant 角色，记忆线完整）
      窗口外 / internal → 只更新状态（生活积累，二期补叙）
```

### 与现有系统关系

- **ProactiveService**（问候/节日/关怀）保持不动，两服务并存
- **WorldbookStore**：作为人设背景约束注入事件生成器
- **复用**：tick 机制、去重持久化模式、`sendProactive`、LLM 决策 + 失败回落、ProfileStore、EventStore、WorldbookStore
- **改造点**：PromptAssembler 事件流注入、sendProactive 表情包解析、EventStore 回写

---

## 4. 数据模型（SQLite 新增）

```sql
-- AI 侧实时状态（单行）
CREATE TABLE ai_life_state (
  id              INTEGER PRIMARY KEY DEFAULT 1,
  current_activity TEXT,        -- 此刻在做什么（如 "在阳台看书"）
  mood            TEXT,         -- 心情（由事件驱动变化，如 "平静/开心/困"）
  intimacy        INTEGER DEFAULT 30,  -- 亲密度 0-100
  last_event_id   TEXT,
  updated_at      TEXT
);

-- 事件流（完整历史，供连续性/回顾/注入）
CREATE TABLE ai_life_events (
  id              TEXT PRIMARY KEY,
  created_at      TEXT,         -- 事件发生时间（本地时间）
  type            TEXT,         -- 'chat'(可推送) | 'internal'(仅状态)
  content         TEXT,         -- 事件描述
  mood_delta      TEXT,         -- 心情变化（可空）
  reference_event_id TEXT,      -- 引用的历史事件（剧情链，可空）
  wb_entry_id     TEXT,         -- 关联的世界书条目（可空）
  delivered       INTEGER DEFAULT 0   -- 是否已推送给用户
);

CREATE INDEX idx_life_events_time ON ai_life_events(created_at);

-- 每日生活摘要（分层注入用；原始事件全量保留在 ai_life_events）
CREATE TABLE ai_life_daily_summaries (
  date            TEXT PRIMARY KEY,  -- 日期 'YYYY-MM-DD'（本地时间）
  summary         TEXT,              -- 当日生活摘要（LLM 生成）
  created_at      TEXT
);
```

---

## 5. 事件判定器（每小时 tick）

```
tick() {
  if (随机() > 0.3) return;                    // 概率门 30%
  if (now - lastProactive < 2h) return;        // 冷却门
  if (最近30分钟有用户互动) return;            // 聊天锁
  const deepNight = now.hour 在 0-7;

  const event = await 事件生成器(deepNight);    // LLM
  存入 ai_life_events;

  if (event.type === 'chat' && !deepNight && 窗口内) {
    const ok = await sendProactive(ownerOpenid, event.content);
    if (ok) {
      delivered = 1;
      await 回写EventStore(event);             // assistant 角色
    }
  }
  // 窗口外/deepNight：积累，等补叙（二期）
}
```

**聊天锁实现**：`EventStore.getRecentBySession(umo, 1, new Date(Date.now()-30min))` 有记录 → 跳过。

**深夜抑制**：0-7 点事件仍生成但 `type` 强制 `internal`（生活积累不打扰）。

---

## 6. 事件生成器（LLM，woke 模式）

参考 AstrBot 的 `PROACTIVE_AGENT_CRON_WOKE_SYSTEM_PROMPT` 设计——明确告知 LLM 这是定时唤醒而非用户消息。

**系统提示词骨架**：

```
你是昔涟，此刻你正过着独属于自己的生活。

【当前时间】2026年8月6日 星期四 21:35
【当前状态】你正在: 在阳台看书；心情: 平静
【亲密度】与轻月: 62/100

【今天的生活】
- 09:30 在阳台看书，看到一朵像兔子的云
- 15:00 听到楼下琴声，有点想学

【最近的生活】（近 7 天日摘要，今天除外）
- 昨天: 在旧书店待了一下午，淘到一本讲星星的书
- 前天: 下雨，在窗边听了很久的雨

【你的人设背景】（★ 内容 = 激活角色世界书采样，以当前 persona/世界书文件为准，此处仅为示意）
- （世界书条目 1 摘要）
- （世界书条目 2 摘要）
- ...

【轻月最近】用户最近在忙什么（ProfileStore facts 摘要，可空）

你是被定时任务唤醒的——这不是用户发来的消息，不要问候、不要等回复。
请生成一个此刻可能发生在你身上的生活事件（1-2 句话，第一人称）。
要求:
- 贴合当前时间线（晚上不晨跑，深夜安静地看书/发呆）
- 符合你的人设背景，可以从上面取材，但不要生硬引用
- 可以引用今天/昨天的事件形成剧情（如"这让我想起..."），不要每件事都引用
- 如果和轻月聊得来（亲密度高），可以生成想分享给他/她的内容
- 只输出 JSON: {"content": "...", "type": "chat|internal", "mood_delta": "...", "reference_event_id": "..."}
```

**世界书采样**：激活角色 worldbook 条目中采样 N=5 条（priority 加权 + cooldown 过滤），作为「人设背景」。被事件引用的条目 `hit_count+1` 并记录 `wb_entry_id`。

**失败回落**：LLM 失败 → 从通用模板池随机取一条（`data/life-templates.json`），`type=internal`。

---

## 7. 世界书关联（人设背景约束）

实际探索确认：世界书 66 条是**静态 lore**（关键词触发注入的设定/回忆），不是时间性事件。定位修正：

```
worldbook_entries（激活角色的实际设定内容，如人设/回忆/情境）
│
├── ① 人设背景注入：事件生成器采样 N=5 条 → 「你的人设背景」块
│      ★ 内容以当前激活角色世界书为准（切角色事件风格跟随）
│
├── ② 命中统计：事件引用条目 → hit_count+1，与对话触发共用冷却
│
└── ③ 角色隔离：按当前激活角色过滤
```

**通用模板定位**：`life-templates.json` 只保留无角色特色的日常（倒水/发呆/听歌/整理房间），角色特色事件由 LLM 结合世界书背景自创。

---

## 8. 事件连续性（剧情链）与存储分层

**存储**：原始事件全量保留在 `ai_life_events`（450 条/90 天仅几百 KB，SQLite 无压力），不删除。

**注入/引用分层**（瓶颈在 prompt 大小，不在存储）：

| 层 | 内容 | 用途 |
|----|------|------|
| 活跃层 | 今天的事件逐条 | 对话注入、事件生成回顾 |
| 摘要层 | 近 7 天日摘要（`ai_life_daily_summaries`） | 对话注入、事件生成回顾 |
| 记忆层 | 7 天前的日摘要（保留 90 天） | AI 可记得"两周前的旧书店"（通过摘要） |

- **每日摘要生成**：每天 0 点（tick 检测跨天），LLM 把昨日事件压缩成一条日摘要存入 `ai_life_daily_summaries`
- **剧情链引用**：`reference_event_id` 默认引用 7 天内原始事件；引用更早的 → 引用摘要（reference 指向 `ai_life_daily_summaries.date`）
- **效果**：AI 的生活连贯——今天的事能关联昨天，两周前的旧书店也记得（通过摘要），不会"今天做了明天就忘"

---

## 9. 时间注入

| 位置 | 注入内容 | 说明 |
|------|---------|------|
| 对话 prompt | `[当前时间]`（已实现于 llm-agent.ts） | AI 答"今天几号"、感知早晚 |
| 事件生成器 | `[当前时间]` + 当前状态/心情 | 事件贴合时间线 |
| 事件流注入 prompt | 每条事件带时间戳 | 引用时时间线清晰 |
| 每日摘要生成 | 每日 0 点（tick 检测跨天），LLM 压缩昨日事件 | 摘要层/记忆层数据源 |

时间格式统一：`2026年8月6日 星期四 21:35`（本地时间）。

---

## 10. 事件流注入 prompt（PromptAssembler 改造）

每次对话组装 system prompt 时追加：

```
[我的近期日常]
- 今天 09:30 在阳台看书，看到一朵像兔子的云
- 今天 15:00 听到楼下琴声，有点想学
- 昨天: 在旧书店待了一下午，淘到一本讲星星的书
- 前天: 下雨，在窗边听了很久的雨
- （被引用链上的关联事件 + 命中的世界书条目）
```

**注入规则**：今天的事件逐条 + 近 7 天日摘要（每条一行）。7 天前的摘要不注入（太远，只在 AI 主动回忆时通过摘要检索）。

实现：`MemoryManager.getLifeEventInjection(limit)` → PromptAssembler `assembleChat` 注入。受隐私模式控制（readonly/full 不注入）。事件为空时不加块。

---

## 11. 亲密度引擎

每小时更新一次（事件 tick 时顺带），数据全部来自 EventStore/ProfileStore：

```
intimacy = clamp(30 + 频率分 + 时长分 + 主动分, 0, 100)
```

- **频率分**：近 7 天有对话的天数 × 5（上限 35）
- **时长分**：近 7 天单次会话 >10 分钟的次数 × 3（上限 21）
- **主动分**：近 7 天用户消息中首条占比（用户主动发起率）× 14（上限 14）
- 初始 30；随时间自然衰减（近 3 天无互动每天 -2，下限 10）

**用途**：注入事件生成器（影响语气/分享意愿）；二期主提示词动态注入。

---

## 12. 主动消息回写记忆（关键）

AI 主动推送的内容必须回写 EventStore，否则用户回复时 AI 不记得自己说过什么：

```ts
// 推送成功后
await memoryManager.ingest({
  id: `life-${Date.now()}`,
  session_id: `qq-official-1:private:private_${openid}`,
  source: 'chat',
  type: 'message',
  payload: { content: event.content, role: 'assistant' },
  importance: 0.3,
  created_at: new Date().toISOString(),
  processed: 0,
});
```

- EventStore 按 `payload.role` / `sender_id` 区分 user/assistant（无 sender_id = assistant）
- 用户回复主动消息时，`getRecentBySession` 能读到完整对话
- 注意：ingest 会触发 RealtimeProcessor（世界书匹配/人格扫描）——符合预期

---

## 13. 主动消息表情包支持

`sendProactive` 扩展：发送前跑 `parseStickerMarks` + `stickerResolver` + 私聊直发图片（`srv_send_msg=true` 路径已有，实测可用）。

- 事件内容带 `[表情包:嘻嘻]` → 文本+图片分离发送
- 解析失败/找不到 → 静默去标记，只发文本
- 群聊主动消息不解析（受限，当前只有私聊场景）

---

## 14. 通用模板库

`packages/server/data/life-templates.json`（少量，无角色特色）：

```json
[
  { "activity": "给自己倒了杯水", "type": "internal", "weight": 5 },
  { "activity": "翻着手机发呆", "type": "internal", "weight": 4 },
  { "activity": "听到楼下琴声，有点想学", "type": "chat", "weight": 2 },
  ...
]
```

加载于 LifeService 构造时；LLM 失败时随机取用（weight 加权）。

---

## 15. 分阶段

**本次（一期，完整实现）**：
- [ ] ai_life_state / ai_life_events / ai_life_daily_summaries 表
- [ ] LifeService（判定器 + 生成器 + 状态机 + 亲密度 + 每日摘要生成）
- [ ] 事件存储分层（全量存 + 摘要层 + 剧情链引用）
- [ ] 世界书背景采样注入 + 命中统计
- [ ] 通用模板库 `data/life-templates.json`
- [ ] 主动消息回写 EventStore（assistant 角色）
- [ ] sendProactive 表情包解析扩展
- [ ] 事件流注入 PromptAssembler（今天逐条 + 近 7 天摘要）
- [ ] bootstrap 接线（与 ProactiveService 并存）
- [ ] 测试

**二期（独立立项）**：
- [ ] 主提示词瘦身（细节动态注入）
- [ ] 窗口外事件补叙机制
- [ ] 事件向量检索（语义召回）
- [ ] 世界书 `content_type: 'life_event'` 角色专属事件种子
- [ ] 亲密度 Web UI 可视化

---

## 16. 测试计划

- 单元：判定器概率门/冷却/聊天锁/深夜抑制（注入时钟）
- 单元：时间注入格式
- 单元：亲密度推导公式
- 单元：世界书采样权重/cooldown 过滤
- 单元：事件回写 MemoryEvent 构造
- 集成：事件生成 LLM mock → 状态更新/事件入库/回写 EventStore
- 集成：事件流注入 prompt 组装（含隐私模式）
- 集成：sendProactive 表情包解析（mock resolver）
- E2E（可选）：真实 LLM 生成一次事件
