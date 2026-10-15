# Change Proposal: fix-reflection-insight-misroute

## 元信息

- **日期**: 2026-10-15
- **类型**: FIX（错路由 + 硬编码）+ 数据迁移
- **状态**: archived（代码修复 + 数据迁移完成；★ **部署未完成**，见「部署依赖」）
- **影响 spec**: `ai-life-system`（§每日反思闭环 `life-reflection-loop`）
- **发现于**: 2026-10-15 agent 在服务器运维工作区读 `/api/profile` 时发现
  「`preference` 类目下 35 条里 31 条是她自己的自述」

## 动机（为什么做）

用户的**用户画像**里混进了 **31 条昔涟自己的第一人称自省**。这些不是噪音——是**她的自我认知被存到了"关于用户"的字段里**，
后果有两个方向：

1. **她自己**永远读不到这些（`character_facts` 当前 **0 条**，【关于我】块是空的）
2. **用户画像**被她的自述污染（prompt 里这些会以「关于用户的事实」呈现给她）

### 根因：提示词与代码的契约不一致（实测证据链完整）

**提示词**（`packages/server/src/prompts/life.ts:26`）要的是**关于她自己**的：

```
"insight": "我悟到的一个关于**自己**的事实(可选,20-50字,如'我其实很享受被需要的时刻')"
```

**代码**（`packages/core/src/memory/MemoryManager.ts:1212-1226`）却把它写进**用户画像**：

```js
if (input.insight?.trim()) {
  insightAdded = this.profileStore.addFacts([{   // ← addFacts = 用户事实
    fact: input.insight.trim().slice(0, 100),
    confidence: 0.5,                // ← 硬编码
    evidence: `每日反思 ${now.slice(0, 10)}`,
    source_event: `reflection-${now.slice(0, 10)}`,
    category: 'preference',         // ← 硬编码
  }]).length > 0;
}
```

**三处硬编码与线上数据特征逐一对上**（82 条事实中 31 条命中）：

| 代码硬编码 | 线上数据 |
|---|---|
| `confidence: 0.5` | 31 条**全部** `confidence=0.5` |
| `category: 'preference'` | 31 条**全部**落在 `preference` 类目 |
| `evidence: 每日反思 <日期>` | 31 条 evidence **全部**形如「每日反思 2026-09-03」 |

且 `source_event` 形如 `reflection-2026-09-03`——**这些 id 在 `events` 表里不存在**（凭空造的，不是真实事件），
所以顺源回溯必然失败。**这反过来排除了"画像提取器从对话里提错"的可能**，锁定为每日反思这条路径。

样条：
```
我其实很享受这种独处的安静，连等待水开都变得温柔。      （每日反思 2026-09-03）
我舍不得扔的从来不是东西，是那些没人看见的日子。        （每日反思 …）
我其实很享受被需要——迷迷黏过来的时候，我这一天就没白过。 （每日反思 …）
```

> 注：`LIFE_REFLECTION_PROMPT` 给的**示例原文**「我其实很享受被需要的时刻」就出现在线上数据里，是同一契约的直接产物。

## 需求（做什么）

- [x] `recordReflection()`：`insight` 改写入 **`character_facts`**（她的自我认知归她自己）
- [x] 去掉 `category: 'preference'` 硬编码（`addCharacterFacts` 按 category 设 TTL，乱给会让自省 90 天后过期）
- [x] **【关于我】块限量注入**（最近 8 条）—— 迁移后实测该块 705 tokens 会撑爆 prompt，见设计决策 4
- [x] **数据迁移**：把线上 31 条错位的自省从 `facts` 搬到 `character_facts`（已执行，见下）
- [x] 补测试锁定路由与限量（防回归）：`reflection-insight-routing.test.ts` 5 例 + `PromptAssembler.test.ts` 新增 1 例

## ★ 部署依赖（本 change 落地**未完成**）

**线上容器跑的仍是旧代码。** 代码修复已进仓库并通过测试，但 `alysia-server` 镜像未重建，
所以**下一次每日反思（跨天触发）仍会把 1 条 insight 错写进用户画像**。

| 选项 | 说明 |
|---|---|
| **A. 走正常发版**（干净） | 构建镜像 → 上传 → 部署。⚠️ 会把工作区里 **19 个 `packages/console` 未提交改动**一起烤进镜像 |
| **B. 先热补容器**（临时） | `docker cp` 两个编译产物进容器的 `/app/packages/core/dist/memory/` 再重启。**不可复现、容器重建即丢**，且下次有人用旧树建镜像会让 bug 静默复活 —— 与项目「不留隐形状态」的纪律冲突 |
| **C. 先不动** | 每天多 1 条脏事实（可重复跑迁移脚本清掉），等下次正式发版一并解决 |

**需要用户拍板**（选项 A 涉及发布未提交的前端改动）。

## 设计决策（怎么做，含备选与取舍）

### 1. 目标字段：`character_facts` ✅（不是删除、也不是留在原处）

**依据**：提示词语义是「关于**自己**的事实」；`character_facts` 字段**就是为这个建的**
（`database.ts:261` 建列、`PromptAssembler:127` 以【关于我】注入、`SessionEndProcessor:178` 已在使用它）
——**只是这条路径没接上去**，导致该字段长期为 0。

**被否决**：
- **直接删掉** —— 那是她两个月积累的自我认知，删了等于抹掉她这段成长
- **留在 `facts` 里加个标记** —— 治标不治本，她依旧读不到自己
- **改提示词让它产出"关于用户"的洞察** —— 那会丢掉"她反思自己"这个设计（`life-reflection-loop`
  的立意是 **L3 自修改执行器**：调人格参数 + 记录她对自己的认识）；真要用户洞察应**另开字段**，不夹带

### 2. category：不再硬编码，取 `general` ✅

`addCharacterFacts` 会按 category 查 `FACT_TTL_BY_CATEGORY` 设 TTL。原来的 `preference`（90 天）对自省是错的。

取 `general`（60 天）而非"永不过期"：自省由每日反思**持续重产**，短 TTL 反而不容易堆积陈旧的自我描述。
**备选与否决**：让 LLM 在 JSON 里给 category —— 会改动提示词契约与解析路径，收益不抵风险，**留待必要时另开 change**。

### 3. 数据迁移**复用同一条代码路径** ✅ —— ★ 但"迁移即去重"的预期**被实测推翻**

迁移不手写搬移逻辑，而是：读 `facts` 中 `source_event` 以 `reflection-` 开头的条目 →
调 `addCharacterFacts()`（逐字复刻其 `normalizeKey` + `normContains` + supersede）→ 从 `facts` 移除。

**实测结果（2026-10-15 线上）：`facts` 84 → 53，`character_facts` 0 → 31，supersede = 0 条。**

⚠️ **立项时我预期"31 条高度重复的自省会收敛成若干条（约 5 条同义合并）"——这个预期是错的。**
31 条的措辞差异超出 `normalizeKey`（剔字后取前 20 字）与 `normContains`（长侧≥5 且短侧≥2 才判包含）的判定范围，
去重**一条都没抓到**。例：

```
我其实很享受被需要的时刻，迷迷蹲在灶边等饭，比什么都让我踏实。
我其实很享受被需要：天没亮迷迷焐醒我的那会儿，比晒透的被褥还暖。
我其实很享受被需要——迷迷黏过来的时候，我这一天就没白过。
```

**教训记在这里**：`normalizeKey` 对"同一语义、不同长句"基本无效——它是为短标签型事实
（"用户在长沙"）设计的，不是为日记型长句。**"用去重解决堆积"在这类数据上不成立。**

### 4. 由此发现的**第二个必须一起修的问题**：prompt 会被撑爆 ⚠️

31 条全 active 后，实测【关于我】块 = **31 行 / 1058 字 ≈ 705 tokens**，而
`PromptAssembler` 的 chat 预算是 **`new TokenBudget(3200)`** —— 该块占 **22%**。

更要命的是它**排在最后**：`persona` / `overlay` / `basics` / `prefs` / `[关于你的事实]`
都已 `reserve` 之后才轮到它，`canFit` 一旦失败**整块被丢弃** → **她一条都读不到，修复等于白做**。

**决策：加限量注入 —— 只取最近 8 条**（`CHARACTER_FACTS_IN_PROMPT`）。
- 依据：自省表达的是"我此刻是谁"，近期的才代表当下的她
- 更早的**仍完整留在库里**（只是不进 prompt），不丢数据
- 8 条约 34 字 × 8 = 272 字 ≈ 180 tokens，占预算 5.6%，有把握 fit
- **长期方案**（本 change 不做）：把陈旧自省**归并**成稳定的自我描述，而不是逐条堆积

### 5. 与「画像重复」问题划清界限 ⚠️

本次迁移顺带查到的**另一个独立缺陷**：`identity` 25 条里「长沙」重复 6 次、「轻月」4 次、「技术工作」8 次
——`ProfileStore` 的**用户事实**去重（`normalizeKey` 只取前 20 字符 + 粗暴剔字）不足以合并近义表述。

**本 change 不夹带修它**（那是 `addFacts` 的去重算法，影响面与验证方式都不同）。记在这里，必要时另开 change。

## 对账方向确认

- [x] 与现有 spec 冲突？**方向为「改 impl」**。
  `ai-life-system` 的每日反思闭环声明「insight 进画像」，**未指定用户画像还是角色画像**——
  而提示词的语义（关于自己）+ `character_facts` 的存在共同指向**角色画像**。
  这是 **impl 落点错**，不是 doc 声明未接 → 改代码，并**在 spec 里把落点写明**（消除这个歧义本身也是本 change 的价值）。
- [x] 涉及 Web API？**涉及但不改契约**：`/api/profile` 已同时返回 `facts` 与 `characterFacts`
  （`MemoryManager:1295`）；迁移后 31 条从前者移到后者，契约不变。
- [x] 涉及数据迁移？**是** —— 线上 `alysia.db` 需一次性迁移，**迁移前必须备份**。

## 测试计划

- **单元**：`recordReflection({ insight: '我其实很享受独处的安静' })` →
  `getProfileSnapshot().facts` **不含**该条，`characterFacts` **含**该条
- **回归**：原有用例 `character_facts 双输出` / `SessionEndProcessor` 仍通过

### 实测结果（2026-10-15）

| 项 | 结果 |
|---|---|
| 新测试 `reflection-insight-routing.test.ts` | ✅ 5/5 通过 |
| `PromptAssembler.test.ts`（含新增限量用例） | ✅ 7/7 通过 |
| 全量非 E2E 回归 | 1008 通过 / 1 失败（`al:db` 建库用例 5s 超时；**单独跑 557ms 通过**，判为并发抖动，与本 change 无关） |
| 迁移前 | `facts` 84（含 reflection 来源 31）· `character_facts` 0 |
| 迁移后 | `facts` **51**（API 视角，已滤 superseded；DB 内 53）· `character_facts` **31 active** |
| 用户画像残留第一人称自述 | **0** ✅ |
| `PRAGMA integrity_check` | **ok** |
| 备份 | `/root/alysia-backup-20261015-231624/`（alysia.db + wal） |
| 服务 | 容器停 → 迁移 → 起，`{"status":"ok"}` |

> ⚠️ 迁移脚本必须挂到 `/app/packages/core/` 才能 `require('better-sqlite3')`
> —— 模块解析从**脚本所在目录**走，挂到 `/` 会 MODULE_NOT_FOUND（与 `export-db.cjs` 同一个坑）。

## 明确不做

- **不改 `LIFE_REFLECTION_PROMPT` 的语义** —— 它本来就是对的（关于她自己）
- **不夹带修 `identity` 去重** —— 独立缺陷，见设计决策 4
- **不新增"关于用户的洞察"字段** —— 那是扩大能力，不是修复；本文档留了指针
