# persona/ 注入点地图

> ★ 8-30 集中化（worldview-centralize）：修改**公共底色**（跨世界之窗/独立生活/生活中心）
> 只改 `worldview.md`，以下注入点自动同步。修改其他 persona 文件同理（PERSONA_FILES 注入聊天）。

## 注入点清单

| 数据源 | 注入到哪里 | 取用方式 | 修改时检查 |
|--------|-----------|---------|-----------|
| `worldview.md`（公共底色唯一数据源） | ① 聊天 persona 注入（PERSONA_FILES 原文）<br>② 事件生成【世界观底色】块（life.ts,`getWorldviewBlock('all')` 全文）<br>③ 聊天强化块【生活底色】【跨世界之窗】（llm-agent.ts,`getWorldviewBlock('life'/'window')` 按节） | MemoryManager.getWorldviewBlock(section) | 改这里,①②③ 全同步 ✓ |
| `identity.md` | 聊天 persona 注入 | PERSONA_FILES | 只注入聊天 |
| `daily_life.md` | 聊天 persona 注入 | PERSONA_FILES | 只注入聊天 |
| `talk_system.md` | 聊天 persona 注入 | PERSONA_FILES | 只注入聊天 |
| `worldbook/` | 世界书采样（事件生成 + 对话匹配） | getWorldbookSample | 角色设定,分层随机采样 |

## 场景专属约束（不在此目录,各自层维护）

| 约束 | 位置 |
|------|------|
| 事件生成 9 条 + JSON 格式 | bootstrap.ts systemPrompt |
| 事件间隔/心情/剧情链/在场角色块 | life.ts generateEvent context |
| 意图使用协议（[intent:] 标记） | llm-agent.ts |
| 群聊提醒 | llm-agent.ts |
| 意图裁决/摘要/mood note systemPrompt | bootstrap.ts |

## 修改口诀

1. **公共底色**（怎么看待世界/轻月/自己）→ 改 worldview.md,其余自动
2. **人设细节**（身份/日常/说话系统）→ 改对应 persona 文件,只影响聊天
3. **场景行为规则** → 改各层代码（见上表）,不进 persona
