# Change Proposal: persona-overlay-perspective

## 元信息
- **日期**: 2026-08-29
- **类型**: MODIFY
- **状态**: archived
- **影响 spec**: `memory-system`

## 动机
人格调整无"证据门槛"——单次反馈立即生效,无稳定演化概念。HDSI Overlay:达到证据门槛的稳定变化才固化;Perspective:独立于设定的外壳人格层。

## 需求(简化落地)
- [ ] 证据门槛:PersonaAdapter 同向调整 ≥3 次 → 固化一条 overlay 备注("昔涟变得更{维度}{方向},证据:最近 N 次同向反馈/情绪漂移"),存入 persona.overlay_notes(新列,ALTER)
- [ ] PromptAssembler 注入【你的稳定变化】块(overlay 备注,带证据)——仅注入了固化的稳定演化,单次调整不注入
- [ ] 24h 回归只作用于未固化参数(固化参数保留稳定值,不再被拉回默认)

## 对账
- [x] spec 人格自适应节更新;涉及 Web API(getPersonaSnapshot 加 overlayNotes)
