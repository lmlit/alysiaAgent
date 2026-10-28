export { MemoryManager } from './MemoryManager.js';
export type { RolePackage } from './MemoryManager.js';
// ★ 9-25 wire-importance-signal：供回填脚本 scripts/backfill-life-importance.ts 复用同一套算法
export { lifeEventImportance, moodDeltaToIntensity } from './importance.js';
export { EventStore } from './stores/EventStore.js';
export { ProfileStore } from './stores/ProfileStore.js';
export { PersonaStore } from './stores/PersonaStore.js';
export { ConversationStore } from './stores/ConversationStore.js';
export { KnowledgeStore } from './stores/KnowledgeStore.js';
export { WorldbookStore } from './stores/WorldbookStore.js';
export { LifeStore } from './stores/LifeStore.js';
export type { LifeEvent, LifeState } from './stores/LifeStore.js';
// ★ 2026-10-17（change: add-project-task-delegation）：委托任务表。
//   导出到 barrel 是**必须的**：server 侧只能经 `@alysia/core/memory` 这个入口拿它
//   （core 的 package.json exports 不暴露深路径）。
export { ProjectTaskStore } from './stores/ProjectTaskStore.js';
// ★ 2026-10-19（change: wake-her-on-task-result）：结果事件 outbox
export { ProjectTaskEventStore } from './stores/ProjectTaskEventStore.js';
export type {
  ProjectTaskEvent,
  ProjectTaskEventStatus,
  EnqueueEventInput,
  ProjectTaskEventStoreOptions,
} from './stores/ProjectTaskEventStore.js';
// ★ 2026-10-19（change: wake-her-on-task-result）：事件体构造 + 主 Agent 输入渲染（纯函数）
export {
  buildSubagentResultPayload,
  renderSubagentResultInput,
  computeEvidence,
  outcomeOfStatus,
  type SubagentResultPayload,
  type SubagentArtifact,
  type SubagentEvidence,
  type SubagentOutcome,
  type BuildSubagentPayloadInput,
} from './project-task-result.js';
// ★ 2026-10-19（change: watch-for-stuck-work）：她自己留意到的事（看门狗写入 → PromptAssembler 注入）
export { setSelfNotices, getSelfNotices, clearSelfNotices, renderSelfNoticeBlock } from './self-notice.js';
export type { SelfNotice } from './self-notice.js';
// ★ 2026-10-18（change: `gate-project-tasks-to-offpeak`）：执行窗口判定
//   （纯函数；服务端 `/next` 与工具回执共用同一份规则，避免"两处各判一次"）
export {
  computeTaskWindow,
  DEFAULT_PEAK_WINDOWS,
  type TaskWindow,
  type TaskWindowInput,
  type TaskWindowReason,
} from './project-task-window.js';
// ★ 2026-10-18（change: `let-her-start-her-own-projects`）：她自己发起"做点小东西"的决策纯函数
export {
  decideSelfActivity,
  selfActivityRequestKey,
  selfActivityAcceptanceCriteria,
  type SelfActivityDecision,
  type SelfActivityDecisionInput,
  type SelfActivitySkipReason,
} from './self-activity.js';
// ★ 2026-10-18（change: `make-author-iterate`）：「做一件东西」的显式状态机（纯函数）
export {
  advanceLoop,
  initialLoopState,
  LOOP_PHASES,
  PHASE_PROMPTS,
  type LoopDecision,
  type LoopFacts,
  type LoopPhase,
  type LoopState,
} from './project-task-loop.js';
export type {
  ProjectTask,
  ProjectTaskStatus,
  CreateOutcome,
  CreateInput,
  SubmitResultInput,
} from './stores/ProjectTaskStore.js';
export { WorldbookMatcher } from './engines/WorldbookMatcher.js';
export { PersonaAdapter } from './engines/PersonaAdapter.js';
export { ProfileExtractor } from './engines/ProfileExtractor.js';
export { RealtimeProcessor } from './processors/RealtimeProcessor.js';
export { SessionEndProcessor } from './processors/SessionEndProcessor.js';
export { CronProcessor } from './processors/CronProcessor.js';
export { PromptAssembler } from './PromptAssembler.js';
// ★ 2026-10-25（change: `pin-memory-read-seams`）：把组装器的**选项与回执类型**也导出。
//   此前只有类本身在 barrel 上：包外（server / dsh-adapter）想声明"我传的是 AssembleOptions"
//   只能 `any` 或深路径 —— 而 core 的 exports 不暴露深路径。类型不导出 = 契约不可见。
export type {
  AssembleOptions, AssembleReport,
  ChatBlockKey, CodeBlockKey,
} from './PromptAssembler.js';
export { CHAT_BLOCK_POLICY, CODE_BLOCK_POLICY, worldbookSkipDiagnosis } from './PromptAssembler.js';
// ★ 2026-10-25（change: `assembler-block-registry`）：块注册表本体。
//   公开面要能回答「她这一轮会读哪些块 / 谁优先 / 哪块会写库」——
//   运维排查与后续切面（genres、只读场景跳过写块）都要用它。
export {
  CHAT_BLOCKS, CODE_BLOCKS,
  CHAT_BLOCK_ORDER, CODE_BLOCK_ORDER,
  WRITE_EFFECT_CHAT_BLOCKS,
} from './block-registry.js';
export type { BlockEffect, BlockSpec } from './block-registry.js';
// ★ 2026-10-28（change: `extract-prompt-genres`；P8 第 4 步）：8 个体裁的声明表。
export { GENRES, GENRE_IDS, getGenre } from './genres.js';
export type { GenreId, GenreSpec, PersonaInjection } from './genres.js';
export { filterPII } from './PIIFilter.js';
// ★ 2026-10-21（change: `unify-memory-eligibility`，契约 C1）：记忆资格的**唯一出处**。
//   导出到 barrel 是必需的：server / dsh-adapter 侧判定"这条内容能不能学"时
//   只能经 `@alysia/core/memory` 拿它（core 的 exports 不暴露深路径），
//   否则又会各写一份 `if` —— 那正是本 change 要消灭的东西。
export {
  isEligible,
  originOf,
  filterEligible,
  isMachineOrigin,
  describeSkip,
  ELIGIBILITY,
  MEMORY_USES,
  EVENT_ORIGINS,
  USE_LABEL,
  type MemoryUse,
  type EventOrigin,
  type EligibilityVerdict,
  type OriginVerdict,
} from './eligibility.js';
export * from './types.js';
export * from './interfaces/IVectorStore.js';
export * from './interfaces/IEmbedService.js';
export * from './interfaces/ILLMService.js';
export { formatLocalTime, localDateKey, localDateKeyFromISO } from '../utils/time.js';
// ★ 2026-10-20（change: `tidy-a-class-seams`）：提示词资产**对外可读** ——
//   验证脚本必须 import，而不是各自复制一份（复制会漂移，且没人知道哪份是真的）。
//   导出到 barrel 是必需的：server 只能经 `@alysia/core/memory` 拿它
//   （core 的 package.json exports 不暴露深路径）。
export {
  SESSION_SUMMARY_SYSTEM_PROMPT,
  PROFILE_EXTRACT_SYSTEM_PROMPT,
  buildCorrectionPrompt,
  CRON_DEEP_PROFILE_SYSTEM_PROMPT,
} from '../prompts/memory.js';
