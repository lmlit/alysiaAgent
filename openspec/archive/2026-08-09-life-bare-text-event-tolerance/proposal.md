# Change Proposal: life-bare-text-event-tolerance

## 元信息

- **日期**: 2026-08-09
- **类型**: FIX（行为修复）
- **状态**: in-progress
- **影响 spec**: ai-life-system（事件生成/fallback）

## 动机（为什么做）

8-09 云端日志发现：07:16 Life 事件生成失败——LLM 输出裸文本
（`那夜为云描的月光，已随风陪我过了第三日…`，无 JSON 外壳）被 `JSON.parse` 丢弃 →
fallback 加权模板（`听到楼下琴声，有点想学`）→ **模板事件被推送给用户**。

问题双面：
1. **高质量输出被丢**：LLM 裸文本完全贴合剧情链（画云/月亮/长沙），仅因无 JSON 外壳
   被拒——上下文其实在，是格式偏离（deepseek 偶发不守 JSON 约束，当日 1/3 概率）
2. **模板推送造成剧情链断裂**：fallback 模板无角色特色（代码注释自述），推送后与
   此前连续剧情（画月亮/画云）脱节，用户观感"上下文断裂"

## 需求（做什么）

- [x] generateEvent 裸文本容错：JSON.parse 失败但文本非空 → 直接作为事件 content，
      type 与 JSON 路径同规则（`deepNight ? 'internal' : 'chat'`）
- [x] fallback 模板强制 `internal`：LLM 失败（空响应/抛异常/解析成功但无 content）
      时模板事件只入库不推送——不再把无剧情链的模板内容推给用户
- [ ] 测试：裸文本白天 → chat 推送；裸文本深夜 → internal 不推送；
      抛异常 → 模板 internal 不推送（原"invalid JSON → 模板"用例改为容错语义）

## 设计决策

- 裸文本默认 chat（非深夜）：LLM 生成叙述大概率想分享（07:16 文本即"若轻月也在…"）；
  深夜强制 internal（防打扰已有 deepNight 强制）
- 空响应/抛异常仍走模板 fallback（保留兜底），但模板不再推送

## 对账方向确认

- [x] 无 spec 冲突——实现增强（spec 随 change 更新事件生成节）

## 测试计划

- life-service.test.ts：裸文本容错 2 用例 + 模板 internal 1 用例（更新 1 旧用例）
