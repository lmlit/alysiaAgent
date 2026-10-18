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
export { filterPII } from './PIIFilter.js';
export * from './types.js';
export * from './interfaces/IVectorStore.js';
export * from './interfaces/IEmbedService.js';
export * from './interfaces/ILLMService.js';
export { formatLocalTime, localDateKey, localDateKeyFromISO } from '../utils/time.js';
