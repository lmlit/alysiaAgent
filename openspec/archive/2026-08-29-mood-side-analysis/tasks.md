# Tasks: mood-side-analysis

- [x] T1 database.ts:ai_life_state 加 mood_note 列(ALTER + try-catch)
- [x] T2 LifeStore/MemoryManager:mood_note 读写
- [x] T3 life.ts:updateMoodValue 检测 |mv|≥30 且 6h 冷却 → 调 LLM 生成氛围描述(新回调 generateMoodNote,失败冷却重试)→ 存
- [x] T4 bootstrap:generateMoodNote 回调实现
- [x] T5 注入:【心情】块 + 事件生成 context 带 mood_note;回落 |mv|<30 清空
- [x] T6 测试:触发/冷却/回落清空/注入

## Apply
- [x] 合并 spec + index + Web-API + 测试 + 归档
