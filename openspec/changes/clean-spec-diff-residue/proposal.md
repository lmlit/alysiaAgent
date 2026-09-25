# Change Proposal: clean-spec-diff-residue

## 元信息

- **日期**: 2026-09-25
- **类型**: DOC（纯文档）
- **状态**: pending
- **影响 spec**: `memory-system`（§ 末尾「★ 8-29 Overlay 稳定演化」段）

## 动机

`openspec/specs/memory-system/spec.md` 第 711-715 行**残留着 5 行未清理的 `+ ` diff 标记**：

```
+ **★ 8-29 Overlay 稳定演化（persona-overlay-perspective，HDSI Overlay 简化）**：
+ - 证据门槛：PersonaAdapter 同向调整 ≥3 次 → 固化 overlay 备注（persona.overlay_notes 新列）
...
```

这来自 `persona-overlay-perspective` 的 apply 阶段——**合并回主 spec 时没去掉 `+ ` 前缀**。

**实际危害（不是洁癖）**：2026-09-25 做 `fix-credential-leak-in-sync-script` 的 spec 合并时，
按惯例用 `grep -v '^+ '` 剥离新增行来校验，**这 5 行也被连带剥离**，导致：

1. 第一次校验误报"不一致"，差点中止正确的合并
2. 第二次 `sed -n '/^+ /p'` 提取变更行时，**把这 5 行一起抓了进去并去掉前缀写入主 spec**，
   造成 **Overlay 段落被复制一份**

⇒ 残留标记会让任何基于 `+ ` 前缀的合并/校验工具产生错误结果。

## 需求

- [ ] 去掉 `openspec/specs/memory-system/spec.md` 中这 5 行的 `+ ` 前缀
- [ ] 全文扫一遍是否还有其它残留（`grep -n '^+ ' openspec/specs/**/*.spec.md`）
- [ ] 检查 `/openspec-archive` 技能：apply 阶段的"去 `+ ` 前缀"步骤是否容易漏；
      考虑改成**显式的合并校验**（合并后断言主 spec 中不再有行首 `+ `）

## 对账方向确认

- [x] 与现有 spec 冲突？无——这是**格式残留**，不涉及内容对错
- [x] 涉及 Web API？不涉及

## 备注

本 change 是**纯文档**，按 `openspec/project.md` 第 44 行「纯文档类修改也走同流程」办理，
tasks.md 标"纯文档"。
