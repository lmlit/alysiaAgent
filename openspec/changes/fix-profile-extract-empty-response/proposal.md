# Change Proposal: fix-profile-extract-empty-response

## 元信息

- **日期**: 2026-10-01
- **类型**: FIX
- **状态**: proposed
- **影响 spec**: `memory-system`（画像提取链路 + 采样槽契约）
- **发现于**: change `modularize-core-assembly` 的 E2E 验证（`cron.test.ts` 既有失败）

## 动机（为什么做）

`cron.test.ts` 长期失败：`expected '{}' not to be '{}'` —— `user_profile.basics` 永远是空。

**系统排查后挖出 4 个独立缺陷，其中一个让「画像提取」整条链路静默停摆**：
用户说过的所有事实（城市 / 职业 / 技术栈 / 习惯）从未进入画像，
`PromptAssembler` 的 `[关于你]` 段因此永远为空 —— **她其实不认识你**。

### 证据链（全部实测，非推断）

```
sampling.ts:60   profile.extract.max_tokens = 1024
   ↓  DeepSeek 推理模型把 1024 全花在 reasoning_content，finish_reason=length
OpenAILLMService.ts:50   content 为空 → throw "LLM API returned empty response"
   ↓
ProfileExtractor.ts:127  catch {}  ← 静默吞掉（该文件此前连 logger 都没 import）
   ↓
facts: [] → 画像永不生长
```

对照组：`real-api.test.ts` 同样调用却通过 —— 说明是**概率性触顶**（reasoning 长度随任务复杂度浮动），
所以它被当成了「偶发」而不是 bug。

## 缺陷清单

| # | 缺陷 | 性质 |
|---|---|---|
| **A** | `profile.extract.max_tokens = 1024` 对推理模型太小 | **根因**。9-25 修 `session.summary`（512→2048）时漏掉的同源槽位 |
| **B** | `ProfileExtractor.extract` 裸 `catch {}`，无任何日志 | 为什么 6 个月无人发现 |
| **C** | `CronProcessor.deepProfile` 裸 `catch {}` | 同上，`basics` 长期为 `{}` 的真正原因 |
| **D** | `OpenAILLMService.complete` **只声明两个形参**，静默丢弃 `ILLMService` 约定的第三参 `sampling` | TS 允许「少形参」赋给「多形参」→ 编译期不报错；**整套「按场景分槽」对该实现失效** |
| **E** | `MemoryManager.sampling` 缺省 `undefined` → `slotify` 传 `undefined` → 落回 llmService 自己的默认槽 | 所有场景塌成同一个槽 |

D + E 叠加的后果：`CronProcessor.deepProfile`（要**纯文本**）被套上 `profile.extract` 槽的
`response_format: 'json_object'` → **API 400**（它的 prompt 里没有 "json" 字样）。

### 设计缺陷（A 之外的结构问题）

`profile.extract` **一个槽被两个输出契约相反的调用方共用**：

| 调用方 | 输出 |
|---|---|
| `ProfileExtractor` / `PersonaAdapter` | JSON（prompt 含 `返回JSON`） |
| `CronProcessor.deepProfile` | 自然语言（prompt 是 `返回纯文本总结`） |

共用的结果：给槽开 json 模式则前者活、后者 400；不开则后者活、前者只能裸 `JSON.parse`。

## 需求（做什么）

- [ ] `profile.extract` 槽：`max_tokens` 1024 → 4096，加 `response_format: 'json_object'`
- [ ] **拆出新槽 `profile.deepRewrite`**（纯文本，2048，**不带** `response_format`）给 `CronProcessor`
- [ ] `MemoryManager` 缺省 `sampling` 填 `DEFAULT_SAMPLING`
- [ ] `OpenAILLMService.complete` 接受并**生效**第三参（**替换**语义，非合并）
- [ ] `ProfileExtractor`：改用共用解析器 `parseLLMJson` + **失败记日志**
- [ ] `CronProcessor`：**失败记日志**
- [ ] 测试守卫加强（见下）

## 设计决策

**决策 1：`OpenAILLMService` 的槽语义取「替换」而非「合并」**

构造函数注释原文是「可显式传其他槽」。合并语义会让调用方**无法摆脱**默认槽的字段——
本例正需要摆脱 `json_object`。取替换，与注释一致。

**决策 2：`response_format` 守卫按「输出契约」分类，不按槽名列举**

判据是「该槽的**全部**消费者 prompt 是否都含 `json`」（API 硬要求），
不是「这个槽看起来像不像结构化任务」。原先按槽名列举，于是
① `profile.extract` 被误判为「不该带」；② `deepProfile` 共用它被套上后 400。
新守卫拆成两条：结构化槽必须带 / 纯文本槽必须不带。

**决策 3：`max_tokens` 守卫补上 profile 两个槽**

原守卫（9-25 建）只覆盖 `session.summary` 与 `life.generateSummary`，
**profile 两个槽都漏在外面**——这正是本次 bug 逃逸的缝。补进去。

**决策 4：不顺手修 `PersonaAdapter` 的 `JSON.parse`**

它同样用裸 `JSON.parse`（`PersonaAdapter.ts:57`），但它的 prompt 含 "JSON" 且
目前没观测到失败。**一次只修被证据坐实的问题**，不为「看起来一样」扩大改动面。

## 对账方向确认

- [x] 与现有 spec 冲突？`memory-system` 未声明 `profile.extract` 的具体预算，
      但 §采样槽 一节的精神（9-25 教训：「可见内容与 reasoning 共用预算」）本 change 是**落实**它
- [x] 涉及 Web API？不涉及（纯内部行为）
- [x] 采样槽是 `config.yml` 可见配置 → 新增 `profile.deepRewrite` 需同步 `config.example.yml` 与文档

## 测试计划

| 层 | 内容 |
|---|---|
| 单测（新增） | `OpenAILLMService` 第三参生效 + 替换语义（**接口契约回归**） |
| 单测（加强） | `max_tokens` 守卫覆盖 profile 两槽；`response_format` 守卫按输出契约重写 |
| 单测（更新） | `mergeSampling` 默认值快照 |
| E2E（真 API） | `cron.test.ts` 必须通过（**它就是失败用例**） |
| 回归 | 全仓 + 全部 E2E |
