---
name: openspec-change
description: 创建 OpenSpec change 骨架（propose 步骤）。开发新功能/改行为/修 bug 前必用——任何行为变更先开 change，禁止直改不 archive。用法：/openspec-change <change-name>
---

# OpenSpec Change — propose 骨架

> 治理宪法见 `openspec/project.md`。本技能只做 propose 步骤，apply/archive 见 `/openspec-archive`。

## 流程

1. **确认 change 名**（kebab-case，动词开头，如 `wire-memory-config-knobs`）：
   - 若带参数的 change 名与 `openspec/changes/` 已有目录冲突 → 提示用户改名
2. **判断类型**：NEW（新功能）/ MODIFY（改现有行为）/ FIX（修 bug）/ DOC（纯文档）
3. **判定影响 spec**：查 `openspec/specs/index.md` 找对应 slug；新系统 → 用 NEW 类型新建 spec
4. **判定对账方向**（关键，防抹掉设计意图）：
   - 现有 spec 声明了 X 而 impl 没接 → **改 impl 不改 doc**，change 描述"补实现"
   - 无 spec 覆盖 → 本 change 新建/修改 spec
   - 不确定 → 保留 doc，问用户设计意图
5. **复制模板创建骨架**：
   ```
   openspec/changes/<name>/
   ├── proposal.md   ← 复制 openspec/templates/proposal.md 并填写
   ├── tasks.md      ← 复制 openspec/templates/tasks.md 并填写
   └── spec.md       ← 变更后的完整 spec（涉及的主 spec 全文拷贝 + 变更行 diff 标记 +/-）
   ```
   - spec.md 从 `openspec/specs/<slug>/spec.md` 拷贝，变更行行首加 `+ `（新增）或 `- `（删除），其余原样
6. **涉及 Web API？** → 对照 `docs/Web-API-Design.md`，proposal.md 里勾选该检查项
7. **汇报**：change 路径 + 类型 + 影响 spec + 待办清单（用户确认后可进入 apply）

## 注意事项

- 一个 change 只做一件事（小步）
- tasks.md 是验收清单，每完成一项勾一项；spec.md 是 apply 阶段合并用的"新 spec 全文"
- 纯文档修改也开 change，tasks.md 标"纯文档"
