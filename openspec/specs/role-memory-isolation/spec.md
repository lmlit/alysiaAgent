---
status: parked
source: docs/superpowers/specs/2026-08-02-role-memory-isolation.md
migrated: 2026-08-07
---
# 角色记忆隔离 & 画像隔离 — 设计文档

> 日期: 2026-08-02
> 状态: ⏸️ 搁置（设计留档，后续需要时参考，不实施）
> 原因: 与项目初衷（单角色陪伴体验）不符，过度设计。当前角色系统保持"切换人格+世界书"简单模型。
> 前置: 角色系统（v3）完成

---

## 1. 核心模型

**角色 = 独立世界**。一个角色是一整套独立的配置 + 记忆 + 用户视角：

```
角色 = 独立世界
├── system_prompt（主人格提示词）      ✅ 已隔离（角色包）
├── worldbook（世界书）               ✅ 已隔离（按 role 过滤）
├── persona 参数（tone/style/range）  ✅ 已隔离
├── memory_config（记忆旋钮）         ✅ 已隔离
├── 会话记忆（EventLog/短期上下文）    📌 本次：切换角色 = 切换会话
└── 用户画像（Profile）               📌 本次：per-role 独立画像
```

**规则**：
1. 单会话（一个私聊/群）同时只能激活**一个角色**
2. 切换角色 = 归档旧会话 + 进入新会话（旧角色的对话不进入新角色上下文）
3. 每个角色有**自己独立维护的用户画像**（角色 A 收集的"我"的事实，角色 B 看不到）
4. 用户画像是"该角色眼中的用户"，不是全局共享

---

## 2. 用户画像 per-role

### 2.1 表结构

```sql
-- Migration: user_profile 加 role 列
ALTER TABLE user_profile ADD COLUMN role TEXT DEFAULT 'alysia';
-- 现有行 id=1 → role='alysia'（兼容现有数据）
UPDATE user_profile SET role = 'alysia' WHERE id = 1;
```

每个角色一行 user_profile（basics/preferences/facts 独立）。

### 2.2 ProfileStore 改造

```typescript
// 现有: WHERE id = 1（全局单行）
// 改为: WHERE role = ?（按角色）
get(role?: string): UserProfile;           // role 缺省 → 当前激活角色
updateBasics(role, basics) / updatePreferences(role, prefs) / addFacts(role, facts) ...
```

- `MemoryManager` 内部统一传 `getActiveRoleId()`
- 画像提取（SessionEndProcessor / Realtime 纠正）→ 写入**当前激活角色**的画像
- 无该角色画像行时自动建默认行

### 2.3 影响点

| 文件 | 改动 |
|------|------|
| `ProfileStore.ts` | 所有方法按 role 查询/写入 |
| `MemoryManager.ts` | 传当前角色；`getProfileSnapshot(role?)` |
| `SessionEndProcessor.ts` | 提取 facts 写当前角色画像 |
| `RealtimeProcessor.ts` | 纠正快路径写当前角色画像 |
| `CronProcessor.ts` | deepProfile 读当前角色画像 |

---

## 3. 切换角色 = 切换会话

### 3.1 记忆会话 ID 带角色后缀

```
记忆 session_id = {platformSession}@{role}

例:  qq-official-1:private:private_xxx@alysia    （昔涟的会话）
     qq-official-1:private:private_xxx@workbot   （工作助手的会话）
```

- `MemoryIngestStage` 写 EventLog 时，session_id 追加当前角色
- `MemoryRetrievalStage` 读短期记忆时用同款 session_id → 天然按角色隔离
- Token 统计 key 同样带角色
- 角色未切换时（alysia）行为与现在一致

### 3.2 切换流程（`/role` 命令）

```
用户: /role workbot
  → 1. 归档旧记忆会话: onSessionEnd(private_xxx@alysia)
  → 2. switchRole('workbot')（persona + worldbook + system_prompt 切换）
  → 3. 回复: "已切换到 工作助手 角色，开始新的会话～"
  → 之后消息写入 private_xxx@workbot，读 workbot 的画像
```

### 3.3 Migration

现有 EventLog 的 session_id 无 `@role` 后缀 → 迁移为 `@alysia`：

```sql
UPDATE events SET session_id = session_id || '@alysia'
WHERE session_id NOT LIKE '%@%';
```

---

## 4. 接口

| 接口 | 用途 |
|------|------|
| `MemoryManager.switchRoleWithSession(roleId, platformSession)` | 归档旧会话 + 切换角色（内部调 switchRole） |
| `MemoryManager.getMemorySessionId(platformSession)` | 拼带角色的记忆会话 ID |
| `MemoryManager.getProfileSnapshot(role?)` | 按角色读画像（Web 端） |
| `/role` 命令 | 群/私聊内切换角色（新增 CommandDefinition） |

---

## 5. 兼容性

- 默认角色 alysia：行为与现状完全一致（会话 ID 多 `@alysia` 后缀，内部透明）
- 现有数据 migration 后无损
- 187 测试更新（session_id 断言加后缀）

---

## 6. 实施计划

- [ ] 6.1 database.ts migration：user_profile.role + events.session_id 后缀
- [ ] 6.2 ProfileStore 按角色化（get/update/addFacts 等）
- [ ] 6.3 MemoryManager：getMemorySessionId + 角色透传 + getProfileSnapshot(role)
- [ ] 6.4 MemoryIngestStage / MemoryRetrievalStage：记忆会话 ID 带角色
- [ ] 6.5 SessionEnd / Realtime / Cron：画像读写带角色
- [ ] 6.6 `/role` 命令（session.ts）+ switchRoleWithSession
- [ ] 6.7 LLMAgentStage：stats key 带角色
- [ ] 6.8 测试更新 + 新增（角色会话隔离、画像隔离、切换流程）
- [ ] 6.9 rebuild + 手动验证

---

## 7. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-02 | 初始设计：角色=独立世界，会话记忆 + 用户画像 per-role 隔离 |
