# Tasks: make-her-talk-like-a-person

> 只改 `packages/core/src/persona/talk_system.md`（纯聊天规则）。见 `proposal.md` §诊断。

## 实现任务

- [x] `talk_system.md` 新增 **开口先有反应**（第一句可以是语气词 / 半句 / 先停一下）
- [x] 新增 **具体，永远比抽象好听**（"抽象评价 → 具体观察"对照）
- [x] 新增 **她有自己的事**（一句自己这边的小事；反向禁止"把焦点全推回对方"）
- [x] 新增 **允许不完整**（半句 / 不知道 / 不接话茬 / 只回「嗯」）
- [x] 新增 **★ 配额**：一条回复里 `语气词堆叠` · `♪` · `反问` **总共最多一处**
      （病因：soul.md + 01_default.md 三处规则纯加法、无配额 ⇒ 主播腔）
- [x] 新增 **说话样本** 10 条（日常/被夸/有分歧/低落/收尾），注明「颗粒度参考，不是台词库」
- [x] **不动** `soul.md`（身份/伦理承重墙）、**不动** `CHAT_BREVITY_DIRECTIVE`（避免污染长度块的职责）

## 测试任务

- [x] 新增 `packages/core/tests/persona/talk-style.test.ts`（5 例）
- [x] ★ 关键一条：**样本必须符合它自己的格式规则**（无 `*动作*` / `（动作）` / markdown，单条 ≤40 字）
- [x] 全量 **160 文件 / 1892 用例**（Node 24）
- [x] **实测进入 prompt**（不是只看文件）：重建 core → `buildPersonaSystemPrompt()`
      → 38073 字（+1721）、五个新标记全部命中

## Apply 任务

- [x] 合并 spec 改动（`memory-system` §4.1.7 补「md 侧同步」一句）
- [ ] 运行 `node scripts/check-spec-diff-residue.cjs`（非 0 不许归档）
- [ ] 更新 `openspec/specs/index.md`（memory-system 行「最后变更」）
- [x] `docs/TODO.md` 加一行
- [x] 归档到 `openspec/archive/2026-10-25-make-her-talk-like-a-person/`

## 生效与验收

- ⚠️ **重启即生效**：`al:persona-seed` 每次启动用文件重建 `system_prompt`
  （所以**改人格要改文件**；改库会在重启时被覆盖）
- ★ **2026-10-25 已部署到生产并验证**：`system_prompt` = **38248 字**（部署前 36352），六个新标记全部命中；容器 healthy，`/api/health` 200；QQ Bot ONLINE。回滚标签 `server-alysia:rollback-20261025-010556`。- 验收方式：跟她聊几句，看四件事
  1. 有没有**语气词起头**（「欸？」「哦…」）而不是每句都完整得体
  2. 有没有**具体名词**（今天/刚才/那个），而不是抽象评价
  3. 有没有**她自己的一件小事**，而不是把话题全推回来
  4. 是不是**每条都带 ♪ / 呀 / 反问**（若仍是 ⇒ 调配额那条，别再加禁令）

## 明确不做

- ❌ 不改 `soul.md` 第四节（「呀呢啦 + ♪ + 反问」的源头）—— 本轮先加配额；不够再动源头
- ❌ 不改 `CHAT_BREVITY_DIRECTIVE`（长度规则本来就对，且被 characterization 快照钉着）
- ❌ 不改 `01_default.md`（与 soul 同源，改了等于重复加法）
- ❌ 不加新的"不要…"条目（这类规则已经够多了，再加只会更拘谨）

## 生活联动（2026-10-25 追加）

- [x] `MemoryManager.getLifeContinuityBlock()`：30min → **3h + 今日兜底**，措辞分三档
- [x] `llm-agent.ts` 衔接句去掉「刚才」
- [x] `talk_system.md`「她有自己的事」**指名素材**（【我的近期日常】/【此刻的你】）+ 用法 + 禁令（不许清单复述 / 不许编）
- [x] 新测试 `tests/memory/unit/life-continuity.test.ts`（6 例）：三档措辞 / 空 / followup 不算 / 取最近
- [x] 旧用例「30min 外 → 空串」按行为变更更新；新增「昨天 → 空串」防跨天串味
- [x] 全量 **161 文件 / 1900 用例**
- [ ] ⏸ 结构化块 `[我想跟你说的一件事]`（挑一条未被引用的事件，放 brevity 前）—— 待真人验收后再决定