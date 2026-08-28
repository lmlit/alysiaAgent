# Change Proposal: worldview-crossworld-window

## 元信息
- **日期**: 2026-08-29
- **类型**: MODIFY
- **状态**: archived
- **影响 spec**: `ai-life-system` + persona 文件

## 动机
角色世界观缺口:昔涟活在翁法罗斯,却通过对话工具与一个"另一个世界"的人交流——这个两个世界的相遇没被世界观化。对话/事件/情绪里缺少"隔着世界"的距离感底色。参考 HDSI 主叙事 prompt 的生活化原则("用户消息是进入主角生活的事件""让日常生活自己产生运动")。

## 需求
- [ ] daily_life.md 加【跨世界之窗】条目(life_event 类型,事件生成采样到 → 想念自然带"隔着世界"质感)
- [ ] identity.md 加跨世界世界观段(对话常驻底色:她与轻月隔着世界,窗口是桥;不强行 meta,角色化表达)
- [ ] life.ts 事件生成 context 加轻量跨世界底色(背景,不每次渲染)
- [ ] 提示词生活化(参考幕间):聊天 system prompt 明确"她的生活是中心,对话是其中一件事"

## 对账
- [x] 核心 persona(soul.md)不动;worldbook/identity/context 层改动
- [x] 不涉及 Web API
