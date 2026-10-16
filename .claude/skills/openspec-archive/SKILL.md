---
name: openspec-archive
description: 归档 OpenSpec change（apply + archive 步骤）。实现完成、测试通过后，把变更合并回主 spec、归档到 archive/、更新索引。用法：/openspec-archive <change-name>
---

# OpenSpec Change — apply + archive

> 治理宪法见 `openspec/project.md`。本技能收尾 change 生命周期。

## 流程

1. **确认完成状态**（任一不满足则先补齐）：
   - [ ] tasks.md 全部勾选（或本 change 是纯文档）
   - [ ] 测试通过（运行相关测试套件）
   - [ ] 代码已提交（或明确未提交原因）
2. **apply——合并 spec**：
   - 读 `openspec/changes/<name>/spec.md`（变更后的完整 spec，含 +/- diff 标记）
   - 把变更应用到 `openspec/specs/<slug>/spec.md`：去掉 +/- 标记，替换对应章节
   - 若 change 是 NEW 且新系统 → 新建 `openspec/specs/<new-slug>/spec.md`
   - ★ **合并后必须跑残留校验（机器拦，不靠记性）**：
     ```
     E:\nodejs24\node.exe scripts/check-spec-diff-residue.cjs
     ```
     **exit 非 0 = 有行首 `+ ` 残留，不许继续归档。**
     修法是**剥掉行首的 `+ `（保留其余内容与缩进）**，**不是删行** ——
     那些行常常是主 spec 里**唯一**的一份内容。
     > 为什么写进流程：2026-09-25 立项的 `clean-spec-diff-residue` 就是"靠人记得去剥前缀"，
     > 结果 40 行残留了 21 天，还在一次合并里把 Overlay 段落**复制了一份**。
     > 残留会让任何基于 `+ ` 前缀的合并/校验工具给出错误结果。
     > ⚠️ 代码块内的 `+` 行是**合法内容**（diff 示例 / 提示词模板），脚本会把它们区分开，别手动删。
3. **更新索引** `openspec/specs/index.md`：
   - 对应 slug 行：状态（新系统插入新行）、最后变更列 → `YYYY-MM-DD <change-name>`
   - backlog change 移出 📌 Backlog 节（若在列）
4. **归档**：
   ```
   mv openspec/changes/<name> openspec/archive/<YYYY-MM-DD>-<name>
   ```
   - proposal.md 顶部状态字段 → `archived`
5. **汇报**：归档路径 + 合并的 spec 章节 + 索引变更

## 注意事项

- 归档即闭环：change 从 changes/ 消失，审计记录留在 archive/
- 若 apply 时发现 spec 与实现又出现新的不一致 → 按对账规则处理（impl 对改 doc / doc 声明未接 → 另开 change），不要在本 change 里夹带
- 涉及 Web API 的 change 记得确认 docs/Web-API-Design.md 已同步
