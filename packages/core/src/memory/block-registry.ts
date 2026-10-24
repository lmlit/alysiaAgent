/**
 * 提示词块的**唯一注册表**（★ 2026-10-25，change: `assembler-block-registry`；P8 第 2 步）
 *
 * ## 为什么要有它
 *
 * `assembleChat()` 原本把「有哪些块 / 谁先谁后 / 谁 required」**写在一个 400 多行的函数体里**：
 * 顺序由 `pushChatBlock()` 的调用顺序隐式决定，策略表另在文件头。
 * 于是"加一块"必须改函数体中部，而"这块钱从哪来、会不会写库"**根本没地方写**。
 *
 * 现在三件事集中在**一张表**上：
 *   1. `key`      —— 块标识
 *   2. `policy`   —— `required` / `optional`（预算语义）
 *   3. `effect`   —— **`read` / `write`**：构建这一块会不会**写库**
 *
 * ## `effect` 不是装饰：它记录了一个真实的隐患
 *
 * `pendingConfirm` 块的数据源 `listPendingConfirmFacts()` 内部会先跑
 * `expireStaleFacts() → writeFacts()` —— 也就是说 **每轮组装 prompt 都可能写 DB**
 * （组件是读路径，副作用是写）。因为它是隐式的，历史上这里吞掉过一次写失败而无人发现
 * （见 `PromptAssembler` 里那条 KI-5 注释）。
 *
 * 声明成 `effect: 'write'` 之后，这件事至少**可查、可测、可被上层决策**（例如将来
 * 隐私 `readonly` 会话里就不该跑带副作用的那块）。**本轮不改行为**，只把它显式化。
 *
 * ⚠️ 顺序即优先级（谁先占预算）。改这张表的顺序 = 行为变更，必须更新 characterization 快照
 * 并说明"谁该让位"。
 */

export type ChatBlockKey =
  | 'selfNotice' | 'persona' | 'overlay' | 'basics' | 'preferences'
  | 'facts' | 'characterFacts' | 'pendingConfirm' | 'recentConversations'
  | 'worldbook' | 'life' | 'memories' | 'brevity';

export type CodeBlockKey = 'persona' | 'techProfile' | 'projectContext' | 'worldbook' | 'life' | 'memories';

/** 构建这一块时会不会写库 */
export type BlockEffect = 'read' | 'write';

export interface BlockSpec<K extends string> {
  key: K;
  policy: 'required' | 'optional';
  /**
   * `read`  = 纯读
   * `write` = **构建该块的过程可能写库**（副作用）。出现它必须能说出"为什么读路径要写"。
   */
  effect: BlockEffect;
  /** 数据源（写给人看，用于"这块钱从哪来"的追溯） */
  source: string;
  /** 已知代价 / 历史事故（可省略） */
  note?: string;
}

/** **数组顺序 = 组装顺序 = 预算优先级**。 */
export const CHAT_BLOCKS: ReadonlyArray<BlockSpec<ChatBlockKey>> = [
  {
    key: 'selfNotice', policy: 'required', effect: 'read', source: 'getSelfNotices()',
    note: '最靠前：它决定"此刻该不该说点什么"，比背景知识更即时',
  },
  { key: 'persona', policy: 'required', effect: 'read', source: 'personaStore（name/tone/speech_style/emotional_range）' },
  { key: 'overlay', policy: 'optional', effect: 'read', source: 'personaStore.getOverlayNotes()' },
  {
    key: 'basics', policy: 'optional', effect: 'read', source: 'profileStore.basics + getBasicsMeta().stale',
    note: '过时且当前有事实 ⇒ 整块跳过（由事实块承载当前认知）',
  },
  { key: 'preferences', policy: 'optional', effect: 'read', source: 'profileStore.preferences' },
  { key: 'facts', policy: 'optional', effect: 'read', source: 'profileStore.getActiveFacts()（组装层去重）' },
  {
    key: 'characterFacts', policy: 'optional', effect: 'read', source: 'profileStore.getActiveCharacterFacts()',
    note: '历史上整块被 31 条自省挤掉过 ⇒ 限量取最近 N 条',
  },
  {
    key: 'pendingConfirm', policy: 'optional', effect: 'write',
    source: 'profileStore.listPendingConfirmFacts()',
    note: '★ 该调用内部会 expireStaleFacts() → writeFacts()：读路径带写副作用（KI-5）',
  },
  { key: 'recentConversations', policy: 'optional', effect: 'read', source: 'conversationStore.getRecent(3, sessionId)' },
  {
    key: 'worldbook', policy: 'optional', effect: 'read', source: '入参 triggers（按 worldbookScope 过滤）',
    note: 'opt-in：给 worldbookScope 才注入；2026-10-24 之前这个参数是死的（22 天无感）',
  },
  { key: 'life', policy: 'optional', effect: 'read', source: '入参 lifeInjection（getLifeEventInjection 预组装）' },
  { key: 'memories', policy: 'optional', effect: 'read', source: '入参 retrieved（语义召回）' },
  {
    key: 'brevity', policy: 'required', effect: 'read', source: 'prompts/chat.ts CHAT_BREVITY_DIRECTIVE',
    note: '放最后：输出约束离生成位置越近越有效；required：被丢就等于她话痨',
  },
];

export const CODE_BLOCKS: ReadonlyArray<BlockSpec<CodeBlockKey>> = [
  { key: 'persona', policy: 'required', effect: 'read', source: 'personaStore' },
  { key: 'techProfile', policy: 'optional', effect: 'read', source: 'profileStore（技术画像）' },
  { key: 'projectContext', policy: 'optional', effect: 'read', source: 'codeContextStore' },
  { key: 'worldbook', policy: 'optional', effect: 'read', source: '入参 triggers' },
  { key: 'life', policy: 'optional', effect: 'read', source: '入参 lifeInjection' },
  { key: 'memories', policy: 'optional', effect: 'read', source: '入参 retrieved' },
];

const toPolicy = <K extends string>(specs: ReadonlyArray<BlockSpec<K>>) =>
  Object.fromEntries(specs.map((s) => [s.key, s.policy])) as Record<K, 'required' | 'optional'>;

/** 由注册表**派生** —— 不再手写第二份（手写过，就会漂移）。 */
export const CHAT_BLOCK_POLICY: Record<ChatBlockKey, 'required' | 'optional'> = toPolicy(CHAT_BLOCKS);
export const CODE_BLOCK_POLICY: Record<CodeBlockKey, 'required' | 'optional'> = toPolicy(CODE_BLOCKS);

/** 组装顺序（供测试与调用方对齐） */
export const CHAT_BLOCK_ORDER: ReadonlyArray<ChatBlockKey> = CHAT_BLOCKS.map((b) => b.key);
export const CODE_BLOCK_ORDER: ReadonlyArray<CodeBlockKey> = CODE_BLOCKS.map((b) => b.key);

/** 会写库的块（当前只有 pendingConfirm）。上面的层可据此在只读场景里跳过它们。 */
export const WRITE_EFFECT_CHAT_BLOCKS: ReadonlyArray<ChatBlockKey> =
  CHAT_BLOCKS.filter((b) => b.effect === 'write').map((b) => b.key);
