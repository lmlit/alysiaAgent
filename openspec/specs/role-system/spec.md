---
status: active
source: docs/superpowers/specs/2026-07-31-role-system.md
migrated: 2026-08-07
---
# 角色系统（角色包 + 世界书 + 素材）— 设计文档

> 日期: 2026-07-31
> 状态: 已实现（2026-08-07 治理对账：原标注"草稿"滞后于实现，PersonaStore 多行化/导入导出/
> WebUI 路由均已落地）
> 前置: 知识库导入完成

---

## 1. 背景与目标

### 1.1 需求

- 支持**切换角色**：不只是"换名字"，而是完整的人格 + 世界书 + 预设素材一起换
- **表情包/预设回复**：关键词精确触发的素材（图片 URL / 预设文案）
- 角色可**导入/导出**（角色包 = 一个 JSON 文件）

### 1.2 核心洞察（来自 Worldbook 调研）

| 内容 | 匹配方式 | 载体 |
|------|----------|------|
| 人格（提示词 + 参数） | 直接注入 | Persona 表（多行化） |
| 世界书（背景/设定） | 关键词触发 | Worldbook 表（加 role 维度） |
| 表情包/预设素材 | 关键词精确触发 | 并入 Worldbook（type 字段区分） |

三者共享同一个"角色"概念：**一个角色 = 人格 + 一套世界书 + 一套素材**。

---

## 2. 数据模型改造

### 2.1 Persona 表多行化

```sql
-- Migration: 新增列
ALTER TABLE persona ADD COLUMN role TEXT DEFAULT 'alysia';
ALTER TABLE persona ADD COLUMN system_prompt TEXT DEFAULT '';  -- 主人格提示词（原 md 文件合并）
ALTER TABLE persona ADD COLUMN is_active INTEGER DEFAULT 0;

-- 现有行（id=1）升级为激活的内置角色
UPDATE persona SET role = 'alysia', is_active = 1 WHERE id = 1;
```

**查询逻辑变更**：
- `PersonaStore.get()` → 查 `is_active = 1` 的行（替代 `WHERE id = 1`）
- 新增 `PersonaStore.getByRole(role)` / `setActive(role)` / `listAll()`

### 2.2 Worldbook 表加 role 维度

```sql
ALTER TABLE worldbook_entries ADD COLUMN role TEXT DEFAULT 'alysia';
ALTER TABLE worldbook_entries ADD COLUMN content_type TEXT DEFAULT 'text';  -- 'text' | 'image' | 'sticker'
```

- `content_type = 'text'`：世界书背景/预设回复（现状）
- `content_type = 'image'`：表情包素材（content = 图片 URL，触发时直接发图）
- `matchByKeywords(keywords, scope, role)` → 加 role 过滤

### 2.3 角色激活状态

激活角色存 **persona 表 is_active 字段**（单行 is_active=1）。切换角色 = 事务里清旧 + 设新。

---

## 3. 角色包格式（JSON）

```json
{
  "role": "cyrene",                    // 唯一 ID
  "name": "昔涟",                       // 显示名
  "version": 1,
  "system_prompt": "（完整主人格提示词，原 soul+identity+system 合并）",
  "persona": {
    "tone": { "formality": 0.2, "warmth": 0.9, "humor": 0.4, "directness": 0.5 },
    "speech_style": { "sentence_length": 0.4, "emoji_usage": 0.3, "code_heavy": 0.0 },
    "emotional_range": { "expressiveness": 0.7, "empathy": 0.9, "playfulness": 0.5 },
    "memory_config": { "retention_bias": 0.2, "decay_rate": 0.3, "importance_threshold": 0.4, "recency_weight": 0.3, "confirmation_bias": 0.3 }
  },
  "worldbook": [
    {
      "trigger_keys": ["翁法罗斯", "泰坦"],
      "trigger_mode": "any",
      "content": "翁法罗斯是……",
      "priority": 10,
      "scope": "chat"
    },
    {
      "trigger_keys": ["晚安", "睡觉"],
      "trigger_mode": "any",
      "content": "https://cdn.xxx/wanan.png",
      "priority": 5,
      "scope": "chat",
      "content_type": "image"          // ★ 表情包素材
    }
  ]
}
```

---

## 4. 接口设计（MemoryManager 门面）

### 4.1 角色管理

```typescript
/** 导入角色包（JSON 或文件路径）→ 写入 persona 行 + worldbook 条目 */
importRole(pkg: RolePackage): Promise<{ role: string; worldbookCount: number }>;

/** 切换激活角色（原子操作：清旧 is_active + 设新） */
switchRole(roleId: string): Promise<void>;

/** 获取当前激活角色信息 */
getActiveRole(): { role: string; name: string; systemPromptPreview: string };

/** 角色列表（Web 展示） */
listRoles(): Array<{ role: string; name: string; isActive: boolean; worldbookCount: number }>;

/** 导出角色包（Web 下载按钮） */
exportRole(roleId: string): RolePackage;
```

### 4.2 配套改动

| 文件 | 改动 |
|------|------|
| `database.ts` | migration：persona + 3 列、worldbook + 2 列 |
| `PersonaStore.ts` | get() 按 is_active；新增 getByRole/setActive/listAll |
| `WorldbookStore.ts` | matchByKeywords 加 role 参数；content_type 字段 |
| `WorldbookMatcher.ts` | match 时带当前角色（从 PersonaStore 读） |
| `PromptAssembler.ts` | 从 PersonaStore 读 system_prompt（替代读 md 文件） |
| `persona/loader.ts` | 启动时把现有昔涟 md 构建为内置角色包 `alysia` 导入（兼容现状） |
| `MemoryManager.ts` | 新增上述 5 个方法 |

### 4.3 Web 接口（更新档案）

| 接口 | 用途 | 状态 |
|------|------|------|
| `GET /api/roles` | 角色列表 | 实施后 🟢 |
| `POST /api/roles/switch` | 切换角色 | 实施后 🟢 |
| `POST /api/roles/import` | 导入角色包 | 实施后 🟢 |
| `GET /api/roles/:id/export` | 导出角色包 | 实施后 🟢 |

---

## 5. 兼容性

- 现有 `id=1` persona 行 → `role='alysia', is_active=1`，行为不变
- 现有 66 条 worldbook → `role='alysia', content_type='text'`，行为不变
- `PersonaStore.get()` 语义保持（返回激活角色）
- 187 测试保持通过

---

## 6. 实施计划

- [ ] 6.1 database.ts migration（persona 3 列 + worldbook 2 列）
- [ ] 6.2 PersonaStore 多行化（getByRole/setActive/listAll）
- [ ] 6.3 WorldbookStore role 过滤 + content_type
- [ ] 6.4 WorldbookMatcher 带角色匹配
- [ ] 6.5 RolePackage 类型 + MemoryManager 5 个方法
- [ ] 6.6 loader.ts 重构：内置昔涟 → 角色包导入
- [ ] 6.7 PromptAssembler / LLMAgentStage 改用 store 的 system_prompt
- [ ] 6.8 测试：角色切换、世界书按角色过滤、素材触发、导入导出
- [ ] 6.9 更新 Web 档案 + rebuild + 手动验证

---

## 7. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-31 | 初始设计。角色 = 人格 + 世界书 + 素材；表情包并入世界书（content_type） |
