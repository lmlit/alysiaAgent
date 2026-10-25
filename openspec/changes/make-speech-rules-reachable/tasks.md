# Tasks: make-speech-rules-reachable

> 上一轮规则写进了不进 prompt 的文件。见 `proposal.md`。

## 实现任务

- [x] `prompts/chat.ts`：`CHAT_BREVITY_DIRECTIVE` 增补「【说话的手感】」一段（≈350 字）
      —— 开口先有反应 / 具体化 / 素材来源 / 没有素材不许编 / **配额** / 允许不完整
- [x] `prompts/chat.ts` 文件头注释改写：讲清**实测依据**（42 节 vs 前 4 节）
- [x] `persona/talk_system.md` 顶部加 🚫 自报声明（不进 prompt + 节数证据 + 生效位置）
- [x] spec `memory-system` 契约 9（人格注入面）

## 测试任务

- [x] 新增 `speech-rules-reachable.test.ts`（6 例）：四件手感在代码块里、配额在、长度首句还在、
      块 < 900 字、★ md 自报声明、★ `getCompactPersonaPrompt(sections = 4)` 默认值被钉住
- [x] 快照按**有意行为变更**更新，并核对 diff：只多 `【说话的手感】`、**丢弃集合未变**
- [x] 全量 **165 文件 / 1935 用例**

## Apply / 部署 / 验收

- [ ] `check-spec-diff-residue.cjs`
- [ ] 更新 `openspec/specs/index.md`、`docs/PROMPT-INVENTORY.md`
- [ ] 部署
- [ ] ★ **真·端到端验收**：调 `POST /api/memory/read`，确认返回的 `context` 里含
      `【说话的手感】`（**这次验的是"到不到模型面前"，不是"DB 里有没有"**）
- [ ] 归档

## 明确不做

- ❌ 不改 `getCompactPersonaPrompt()` 的 4 节上限（会每轮多烧 ≈2.3k 字符，且 `system.md` 与 soul 重叠）
- ❌ 不删 `talk_system.md`（它仍是设计说明 + 新角色包素材，只是**自报无效果**）
