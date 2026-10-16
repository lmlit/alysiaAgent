# Tasks: add-memory-correction

> 产品增量（新功能）。按计划首版范围：**查看 + 纠正 + 失效 + 验证后续对话用新事实**。
> ⚠️ 新功能的测试是**与实现同时写下的契约**，没有「先红后绿」——这一点如实标注。

## 实现任务

### core
- [x] `MemoryManager.correctProfileFact(oldFact, newFact)`：
      **先作废旧（`confirmFact(key, false)`）→ 再写入新（`source:'user'`, `confidence:1.0`）**
- [x] 空新事实 → **在作废之前**抛错（不留"旧的没了、新的没写"的中间态）
- [x] `getProfileSnapshot({ includeSuperseded })`：**可选参数**，默认行为不变
- [x] 旧事实不存在 → `superseded:false` 但**新事实仍写入**

### server
- [x] `POST /api/profile/facts/correct` → `correctProfileFact`
- [x] `POST /api/profile/facts/confirm` → `confirmProfileFact`
      （★ 这条路**此前不存在**：实现早就有、调用方为零）
- [x] `GET /api/profile?includeSuperseded=1` 透传
- [x] 参数校验一律 400 + 具体原因；core 抛错也归 400（不吞、不假装成功）
- [x] `{ ok, found }` 两个字段都在：`found:false` = 没找到，**与操作失败区分**

### console
- [x] `profileApi.getAll / correctFact / confirmFact`
- [x] 新页 `/memory`：用户事实 + 角色事实并列，每条显示**来源/时间/分类**，
      行内「纠正」+「忘掉」，底部列出**已作废的**（证明"真的失效了"）
- [x] 导航加入「记忆」（与「人格」分开：那页是**她是谁**，这页是**她记着什么**）
- [x] 角色事实区**如实标注只读**（不假造失效按钮）

### docs
- [x] `docs/Web-API-Design.md`：§2.3 扩写 + **新增 §2.3.1 / §2.3.2** + 总览表两行

## 测试

- [x] core `profile-correction.test.ts` **13 例**，其中三条是关键：
      - ★★ **只 addFacts 会两条并存**（把危险固化成**前提**，防后人简化）
      - ★★ **纠正后组装进 chat prompt 的【关于你的事实】块里旧事实消失、新事实出现**
        （这是计划第 ④ 条「后续对话用新事实」的**真正验收**，不是看接口返回）
      - ★ `includeSuperseded` 能看到被作废的那条（否则用户只能相信按钮上的话）
- [x] server `webui-profile-correction.test.ts` **16 例**（含 5 组参数校验、core 抛错、found 区分）
- [x] console：`tsc --noEmit` + `next build`（新路由 `/memory` 进静态生成）

## Apply 任务

- [x] A.1 合并到 `openspec/specs/memory-system/spec.md`：**新增「手动纠正契约」**（紧接「冲突解决 (v2)」）
- [x] A.2 合并到 `openspec/specs/alysia-console/spec.md`：新增 `/memory` 页说明
- [x] A.3 更新 `docs/Web-API-Design.md`（见上）
- [x] A.4 更新 `openspec/specs/index.md`
- [x] A.5 运行测试（见下）
- [x] A.6 归档
- [x] A.7 记录部署状态

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| core 定向 | `run tests/memory/profile-correction.test.ts`（`packages/core`） | **13 passed** |
| core 全套 | `run --exclude='tests/memory/e2e/*'`（`packages/core`） | **75 files / 742 passed**（本 change 前 74 / 729） |
| server 定向 | `run tests/webui-profile-correction.test.ts`（`packages/server`） | **16 passed** |
| server 全套 | `npx vitest run`（`packages/server`） | **14 files / 243 passed**（本 change 前 13 / 227） |
| console 全套 | `& E:\nodejs24\node.exe ..\..\node_modules\vitest\vitest.mjs run`（`packages/console`） | **3 files / 83 passed** |
| dsh-adapter 全套 | `npx vitest run`（`packages/dsh-adapter`） | **6 files / 102 passed** |
| console 类型 | `npx tsc --noEmit`（`packages/console`） | exit 0 |
| console 构建 | `npx next build`（`packages/console`） | ✅ 10 个静态页（含 **`/memory`**） |

⚠️ **构建依赖顺序**：server 编译吃的是 **core 的 `dist`**（不是源码）。
改了 core 的公开面后**必须先构建 core**（`packages/core` 下 `npx tsc`），
否则 server 侧 tsc 会报 `Property 'correctProfileFact' does not exist`。
本轮踩到过，记在这里省下次的时间。

## 部署状态

**未部署。** 只改代码与契约。

⚠️ 生效需要**两件事**（与之前几批不同）：
1. core 构建 → server 重启（新端点才存在）；
2. console 构建产物（`/memory` 页）→ 由 server 静态托管。
