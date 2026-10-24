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
- [ ] 归档到 `openspec/archive/YYYY-MM-DD-make-her-talk-like-a-person/`

## 生效与验收

- ⚠️ **重启即生效**：`al:persona-seed` 每次启动用文件重建 `system_prompt`
  （所以**改人格要改文件**；改库会在重启时被覆盖）
- 验收方式：跟她聊几句，看四件事
  1. 有没有**语气词起头**（「欸？」「哦…」）而不是每句都完整得体
  2. 有没有**具体名词**（今天/刚才/那个），而不是抽象评价
  3. 有没有**她自己的一件小事**，而不是把话题全推回来
  4. 是不是**每条都带 ♪ / 呀 / 反问**（若仍是 ⇒ 调配额那条，别再加禁令）

## 明确不做

- ❌ 不改 `soul.md` 第四节（「呀呢啦 + ♪ + 反问」的源头）—— 本轮先加配额；不够再动源头
- ❌ 不改 `CHAT_BREVITY_DIRECTIVE`（长度规则本来就对，且被 characterization 快照钉着）
- ❌ 不改 `01_default.md`（与 soul 同源，改了等于重复加法）
- ❌ 不加新的"不要…"条目（这类规则已经够多了，再加只会更拘谨）
