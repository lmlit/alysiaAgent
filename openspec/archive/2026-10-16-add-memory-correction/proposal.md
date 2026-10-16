# Change Proposal: add-memory-correction

## 元信息

- **日期**: 2026-10-16
- **类型**: NEW（产品增量，计划「第二优先：最小版记忆纠正」）
- **状态**: **archived**（2026-10-16 完成 propose → apply → archive；未部署）
- **影响 spec**: `memory-system`（**新增「手动纠正契约」**，紧接「冲突解决 (v2)」）、
  `alysia-console`（**新增 `/memory` 页**）
- **契约文档**: `docs/Web-API-Design.md` **§2.3 扩写 + 新增 §2.3.1 / §2.3.2**

## 这条要解决什么

**用户能看见她记着什么，却不能改。**

- `GET /api/profile` 能看事实（含 source / validFrom / category）—— 这一半**早就有**；
- `MemoryManager.confirmProfileFact` 与 `ProfileStore.confirmFact` **也早就实现了**，
  但**全仓没有任何调用方** ⇒ 能力一直不可达：**只能看，不能改**；
- 「纠正」在机制上还缺一步：`ProfileStore.addFacts` 的冲突检测按 `normalizeKey`
  的**文本相似**判定，而「用户在长沙」→「用户在上海」**并不相似**
  ⇒ 只调 `addFacts` 会**两条同时 active** ⇒ 召回同时拿到，用户看到**自相矛盾的她**。

计划的四条要求（首版）：查看用户 + 角色事实 / 查看来源与时间 / 纠正并使旧事实失效 /
**验证后续对话使用新事实，而不是继续召回旧事实**。

## 需求（做什么）

- [ ] **R1 查看**：用户事实与角色事实并列；每条带**来源**（你告诉我的 / 我猜的）、
      **时间**、**分类**
- [ ] **R2 纠正**：一步语义 = **先作废旧、再写入新**（不许退化成只 addFacts，见上）
- [ ] **R3 失效**：不给替换地作废一条事实（复用 `confirmProfileFact(fact, false)`）
- [ ] **R4 修好的事实**：`source='user'`，**不被后续 inferred 提取顶掉**
- [ ] **R5 看的见「真的失效了」**：纠正**不删除**（留审计链），所以页面要能显示**已作废**的那条
- [ ] **R6 后续对话用新事实**：验收不看接口返回，要看**组装进 prompt 的事实块**里旧的是否消失
- [ ] **R7 失败要如实**：参数不合 → 400 + 具体原因；"没找到旧事实" ≠ 失败（新事实仍写入）

## 设计决策（怎么做，含备选与取舍）

### D1 纠正 = **core 里的一个方法**，不是路由层拼两次调用

放在 `MemoryManager.correctProfileFact`，而不是让路由先 `confirmFact` 再 `addFacts`：
两次调用会在中间态留下「两条都没有」或「两条都在」的窗口，
而「两条都在」正是自相矛盾的来源。**语义完整的一步**只能有一个实现。

### D2 `getProfileSnapshot({ includeSuperseded })` 用**可选参数**，不改默认

默认仍过滤已作废的（画像展示只要"她现在相信的"）；纠正页显式要全量。
**被否决：直接改成返回全部**——那会让 `/dashboard` 的事实 chip 里冒出划掉的条目。

### D3 首版**只纠正用户事实**，角色事实只读

`ProfileStore` 没有"按 key 作废角色事实"的方法（`confirmFact` 只碰 `facts`）。
**被否决：前端造一个假的失效** —— 那会让用户以为改掉了、其实没有，
属于本项目反复禁止的「把失败演成成功」。**如实标注只读**，需要时再给 store 加方法。

### D4 页面单开 `/memory`，不塞进 `/dashboard`

`/dashboard` 那个事实区是**只读展示**（取 6 条 chip）；纠正是**写操作**。
混在一起会让"看"和"改"的边界糊掉，也容易误点。

## 对账方向确认

- [x] 与现有 spec 冲突？——`memory-system` 的「冲突解决 (v2)」只描述了**自动**冲突解决；
      **未声明**「用户手动纠正」这一路径。本 change **新增契约**（紧接其后）。
- [x] 方向判断：**新增能力**（doc 没有、impl 也没有）⇒ 补 impl + 补 doc。
- [x] 涉及 Web API？——**是**。已同步 `docs/Web-API-Design.md`：
      §2.3 扩写（`includeSuperseded`）+ **新增 §2.3.1 / §2.3.2**；
      总览表的画像行同时补了两条。
- [x] core 方法公开面：新增 `MemoryManager.correctProfileFact`；
      `getProfileSnapshot` 加**可选**参数（向后兼容，既有调用方零改动）。

## 测试计划

| 层 | 落点 | 覆盖 |
|---|---|---|
| core | `packages/core/tests/memory/profile-correction.test.ts`（新，13 例） | 纠正/失效/空新事实抛错/**旧事实不存在仍写入**/`source=user` 不被顶掉/**只 addFacts 会两条并存**（把危险固化成前提）/`includeSuperseded`/**prompt 块里旧事实消失** |
| server | `packages/server/tests/webui-profile-correction.test.ts`（新，16 例） | 两个端点 + `includeSuperseded` 透传 + 参数校验 400 + core 抛错 → 400 + `found=false` 与"失败"区分 |
| console | `npx tsc --noEmit` + `npx next build`（含新路由） | 页面编译与静态生成 |

⚠️ **覆盖边界（不含糊）**：console **没有组件级测试**（无 RTL）⇒ `/memory` 页的
交互（点纠正 → 保存 → 列表刷新）**没有自动化断言**，靠 build + 人工路径。
逻辑层的可测部分已经全部下沉到 core 与 server 两侧的用例里。

## ⚠️ 动手前的提醒

- **别把"纠正"简化成一次 `addFacts`**（D1/R6）：那是本项最容易改错的地方，
  已有一条用例把「两条会并存」固化成**前提**，简化它会立刻红。
- **别在前端假装失效角色事实**（D3）。
- **别把 `superseded: false` 当失败**：它与"没找到"同义，新事实照样写入。
