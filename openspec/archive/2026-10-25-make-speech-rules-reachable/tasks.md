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

- [x] `check-spec-diff-residue.cjs`（exit 0）
- [x] 更新 `openspec/specs/index.md`、`docs/PROMPT-INVENTORY.md`
- [x] 部署（镜像 6de031c7c3a7，`rollback-20261025-111230`）
- [x] ★ **真·端到端验收**：调 `POST /api/memory/read`，确认返回的 `context` 里含
      `【说话的手感】`（**这次验的是"到不到模型面前"，不是"DB 里有没有"**）
- [x] 归档到 `openspec/archive/2026-10-25-make-speech-rules-reachable/`

## 明确不做

- ❌ 不改 `getCompactPersonaPrompt()` 的 4 节上限（会每轮多烧 ≈2.3k 字符，且 `system.md` 与 soul 重叠）
- ❌ 不删 `talk_system.md`（它仍是设计说明 + 新角色包素材，只是**自报无效果**）

## 真·端到端验收证据（2026-10-25 11:14，生产）

上一轮我验的是"DB 里那一列有字"，这次验的是**组装出来的 prompt**：

```
POST /api/memory/read {"query":"今天有点累","mode":"chat","blocks":"chat"}
→ context 长度 2653 字

  ✓ 说话的分寸
  ✓ 说话的手感          ← 本轮新增，此前从未出现在 prompt 里
  ✓ 开口可以先有反应
  ✓ 合计最多一处
  ✓ 我的近期日常        ← 素材来源指名
  ✓ 关于你
```

部署：`rollback-20261025-111230` · health[1]=200 OK · 容器 healthy。

★ 本轮构建路径也踩了坑：本机 BuildKit **拉不到基础镜像元数据**（`auth.docker.io` 被拒），
而 `node:22-alpine` 早在本地缓存里。最终用**完全离线**的姿势构建：
`docker tag <base ID> local/node:22-alpine` → 临时改 Dockerfile 的 FROM → 构建（命中缓存）→ 还原 Dockerfile
→ `deploy.mjs --skip-build`。脚本已加 `--skip-build` 与这段说明。