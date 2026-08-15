# Change Proposal: webui-visual-redesign

## 元信息

- **日期**: 2026-08-15
- **类型**: MODIFY（改现有行为/视觉）
- **状态**: proposed
- **影响 spec**: `webui-system`（视觉体系 + 布局）

## 动机（为什么做）

用户对 WebUI 视觉不满意(布局/质感),要求大改。按 design-taste-frontend + impeccable
两个 skill 的规则做系统化重做。**本 change 补录此前未走治理直接实施的视觉/功能改动,
并登记布局大改(进行中)**——违反"直改不 archive"已承认,补录闭环。

## 已完成(补录,commit a34c237,回退点 ui-v2-gold)

- [x] 配色收敛:去紫/青/粉霓虹,单一金色强调(#c9a05c);背景炭灰 #0a0c10(非纯黑)
- [x] 阴影:glow 全删 → 扩散阴影;卡片/顶栏内顶高光(液态玻璃)
- [x] 交互:button:active 触感;loading → shimmer 骨架(10 页)
- [x] 功能:删除会话弹窗(归档 archived 列/彻底删除)、模板手动新增端点+表单、
  人格参数中文展示、会话页跳转聊天、世界书过滤表情包(contentType)、
  importRole 不再误删同 role seed(66 条恢复)、会话 id 前缀清洗
- [x] 清理失效 token 引用

## 进行中:布局大改(用户明确不满意当前布局)

- [ ] 布局重构(方案待用户确认:见 AskUserQuestion)
- [ ] 完成后打 tag ui-v3(回退点 3)

## 对账方向确认

- [ ] 与现有 spec 冲突?无——webui-system spec 视觉/布局章节待更新
- [x] 涉及 Web API?archive 端点/模板新增端点已登记 Web-API-Design.md(补)

## 测试计划

- [x] vite build + 全量回归(core 358 + server 100)
- [ ] 布局大改后:build + 回归 + detector
