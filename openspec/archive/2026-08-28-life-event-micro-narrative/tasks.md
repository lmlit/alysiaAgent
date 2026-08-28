# Tasks: life-event-micro-narrative

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] T1 深夜抑制关闭：life.ts 移除 deepNight 强制 internal 逻辑（事件类型完全交 LLM + 时间感知）
- [x] T2 life.ts 生成 context 加【生活切片示范】块（平凡物件/具体时辰/伴随小动作/小意外——参考"人时物"结构）
- [x] T3 9 条约束 ⑨ 改为"生活切片"语义：2-4 句、具体时辰、平凡物件、伴随小动作、可有小意外转折（life.ts context + bootstrap systemPrompt 同步）
- [x] T4 延续主路径：【你正在做的事】块强化"续写推进为主（进展/波折/完成），自然收尾才开新"
- [x] T5 post-check 适配：长度 ≤80 → ≤150；重复检测前 12 字 → 前 20 字
- [x] T6 注入预算适配：getLifeEventInjection 今天 3 条 → 2 条，每条注入截断 100 字
- [x] T7 每日摘要 30 字 → 50 字（generateSummary prompt）
- [x] T8 测试：新长度阈值 / 延续引导注入 / 深夜事件类型自由 / 注入截断 / 既有测试适配

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/ai-life-system/spec.md`（★ 从主 spec 拷贝后追加）
- [x] 更新 `openspec/specs/index.md`
- [x] 运行测试验证
