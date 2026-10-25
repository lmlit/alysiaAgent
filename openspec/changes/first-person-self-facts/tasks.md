# Tasks: first-person-self-facts

## 实现
- [x] `memory/self-facts.ts`：`normalizeSelfFact()` / `needsSelfFactNormalize()`（有意保守的边界）
- [x] `MemoryManager.recordReflection()`：insight 写入前归一
- [x] `ProfileStore.normalizeCharacterFactPerspective()`：**原地改**（不走 addCharacterFacts）
- [x] `MemoryManager.repairCharacterFactPerspective()`
- [x] `modules/memory.ts`：启动时调用 + **warn 报条数**

## 测试
- [x] `self-facts.test.ts` 7 例（含"已是第一人称不许改坏"、"不动中间第三人称"、"
      不动用户/轻月开头"）
- [x] 全量 **168 文件 / 1962 用例**

## 本地真机验证（按新规矩，先本地）
- [x] 注入 2 条第三人称 → `pnpm chat` → 启动日志报"把 2 条…改成第一人称"
- [x] ★ **抓到 bug**：清洗用了 addCharacterFacts ⇒ 错的对的**并存**（2 条变 4 条）
- [x] 改成原地替换 → 复验 1 条 → 1 条，残留 0，无并存

## 部署
- [ ] `pnpm deploy`（会强制先跑 smoke；本地已验证过）
- [ ] 部署后看启动日志是否报"把 N 条第三人称自省改成第一人称"（预计 5 条）
- [ ] 部署后复查 `character_facts` 残留第三人称 = 0
- [ ] 归档