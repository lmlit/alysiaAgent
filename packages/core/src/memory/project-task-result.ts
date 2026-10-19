/**
 * 委托任务结果 → **一条记忆事件**（原会话里的"回执"）。
 *
 * ★ 2026-10-18（change: `return-project-task-result`）。
 *
 * 为什么要有这一步（这是"最后两米"里更重要的那一米）：
 *   委托会话的事件被**整段排除**在记忆外（`dsh-adapter` §2.5.2）——
 *   于是「她做过」不会变成「她记得做过」，每次委托都像一次失忆的打工。
 *   这里写的是**类型化的结果记录**，不是原始对话，所以它既能被她回忆起来，
 *   又不会把工程文本喂进画像/人格。
 *
 * 抽成纯函数的原因：事件的形状（id 幂等键 / 三个标记位 / 正文措辞）是这个 change 的**契约本体**，
 * 应该有测试直接钉住，而不是只能从"跑一遍 MemoryManager"间接观察。
 */

import type { MemoryEvent } from './types.js';

export interface ProjectTaskResultInput {  taskId: string;
  projectId: string;
  /** 轮次（0 起）。**进幂等键**：同一条结果重复回传只会命中既有事件 */
  revision: number;
  /** 终态（needs_review / completed / failed / unknown） */
  status: string;
  /** 发起任务的聊天会话；空 ⇒ 返回 null（宁可不记，也不往错误的会话里写） */
  originSessionId: string;
  dshSessionId?: string | null;
  /** 执行端最后一段话（会被截断） */
  summary?: string;
  /** 产物（工作区相对路径） */
  artifacts?: unknown[] | null;
  /**
   * 该项目的**对外地址**（如 `http://<server>:3389/`）。
   *
   * ★ 2026-10-18 补（真机撞出来的）：用户真的在 QQ 上问她要"访问链接"，
   *   而她的回答是「我没存下能直接点开的地址」——因为回执里只有项目/轮次/状态。
   *   地址必须随回执一起给她，否则"她知道做完了"仍然等于"她说不出在哪看"。
   */
  publicUrl?: string;
  /** 注入时钟（测试用） */
  now?: Date;
}

/** 摘要正文上限 —— 这条事件会进她的「最近对话」窗口，别把整份文件塞进去 */
export const MAX_RESULT_SUMMARY_CHARS = 1200;

/** 她说的那句话的长度上限（一句话的活儿，别写成小作文） */
export const MAX_NOTICE_CHARS = 240;

/**
 * 生成「她自己那句话」的提示词（纯函数，便于测试）。
 *
 * 设计要点：
 * - **给事实，不给结论**：模型只拿得到状态/产物/地址，拿不到"该怎么夸自己"。
 * - **地址要逐字**：模型很容易改写 URL，所以提示词里明确"原样抄一遍"，
 *   并且 `finalizeNotice` 会**兜底校验**（缺了就补上）。
 * - **不许编**：以 `status` 为准 —— `failed`/`unknown` 时不许说"做好了"。
 * - 短：2-3 句、不要列表、不要小标题（QQ 消息一条能放下）。
 */
export function buildNoticePrompts(input: {
  /** 她的人设名（如「昔涟」）—— 只用来称呼自己，不用来编内容 */
  personaName?: string;
  projectId: string;
  revision: number;
  status: string;
  summary?: string;
  artifacts?: unknown[] | null;
  publicUrl?: string;
  /**
   * ★ 2026-10-18（补）：**最近对话**。
   *
   * 聊天回复走 pipeline 时会注入人格 + 记忆 + 最近对话；而任务通知原先只喂
   * "事实 + 人格名" ⇒ 那条通知一直是**通用人格**，不像她。现在把同一份上下文给它。
   */
  recentDialogue?: string;
  /**
   * ★ 2026-10-18（补）：**她自己写的「哪里像我」**（`NOTES.md` 里那一节）。
   * 这是她最有辨识度的文字：原先只被阶段闸门读，人看不到。现在随通知给用户看。
   */
  selfStatement?: string;
}): { system: string; user: string } {
  const paths = Array.isArray(input.artifacts)
    ? input.artifacts
        .map(a => (a && typeof a === 'object' && 'path' in a ? String((a as { path: unknown }).path) : ''))
        .filter(Boolean)
    : [];
  const name = input.personaName?.trim() || '昔涟';

  const system = [
    `你叫${name}，正在跟用户说话。`,
    '刚刚**你自己**在工程环境里跑完了一轮（同一件事，换了个干活的场所，不是别人替你做）。',
    '现在用你自己的口吻，把这一轮的结果告诉用户。',
    '',
    '要求：',
    '- 2~3 句，一句话也行；不要列表、不要小标题、不要「回执」这类机器词。',
    '- 用你平常说话的样子（温柔、口语、偶尔一句小小的自嘲或俏皮都可以），但别演过头。',
    '- **像你平时发消息那样**：如果下面给了「最近对话」，就顺着你刚才的语气和称呼说，别突然变成另一个人。',
    '- 只说**事实里有的**：不要编造完成情况、不要替用户验收、不要承诺没做的事。',
    '- 如果这一轮其实失败了或结果不明，要如实说，不许粉饰成"做好了"。',
    '- 如果给了访问地址，**把它原样抄一遍**（一个字符都不要改），放在最后。',
    '- 不要提"委托任务""任务表""状态机""执行端"这类内部概念。',
    // ★ 2026-10-18（change: `unify-her-voice-across-engineering`）：
    //   用户原话「其实工程也是她自己」。这两条禁令是本次修改的**行为要件**：
    //   那一轮就是她，说成"工程那边/执行端"等于把自己当成别人给自己汇报。
    '- ⛔ **不许说"工程那边""执行端""系统说"**——那一轮就是你本人，直接说"我做了/我改了/我发现"；',
    '- ⛔ **不许用"人家"来指代那一轮的你**（那会变成第三个人）。',
    '- **不要描述通知/回执机制本身**（例如"通知已经发出来了""系统告诉我"），直接说结果就好。',
  ].join('\n');

  const facts: string[] = [];
  // ★ 先给"你刚才在跟谁说话、怎么说的"，再给事实 —— 顺序会影响语气
  const dialogue = typeof input.recentDialogue === 'string' ? input.recentDialogue.trim() : '';
  if (dialogue) {
    facts.push('（你最近跟这个人的对话，用来找回你说话的样子）：', dialogue.slice(0, 1800), '');
  }
  const stmt = typeof input.selfStatement === 'string' ? input.selfStatement.trim() : '';
  if (stmt) {
    facts.push('（这件东西做完后，你自己写过一句「它哪里像我」——可以带一点进来，不要照抄整段）：', stmt.slice(0, 400), '');
  }
  facts.push(
    `项目：${input.projectId}`,
    `这是第 ${input.revision + 1} 轮`,
    `这一轮的结果状态：${input.status}`,
  );
  if (paths.length > 0) facts.push(`你这一轮做出来的文件：${paths.slice(0, 8).join('、')}`);
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary) {
    facts.push('', '你那一轮最后写下的交代（可以取材，但要用你自己的语气重说）：', summary.slice(0, 600));
  }
  if (input.publicUrl) facts.push('', `访问地址（必须原样抄进你的话里）：${input.publicUrl}`);

  return { system, user: facts.join('\n') };
}

/**
 * 收口模型的输出：去掉代码块/引号包裹、压成一段、**校验地址逐字存在**。
 *
 * ★ 为什么地址要在这里兜：模型改写 URL 是常见事故（少个端口、多个斜杠），
 *   而用户拿到一个打不开的地址比没地址更糟。缺了就**追加**，不跟模型商量。
 */
export function finalizeNotice(raw: string, publicUrl: string): string {
  let text = (raw ?? '').trim();
  // 去围栏：```...```
  text = text.replace(/^```[a-zA-Z]*\s*/g, '').replace(/```$/g, '').trim();
  // 去整段引号包裹：「…」/“…”/"…"
  text = text.replace(/^[「“"']([\s\S]*)[」”"']$/, '$1').trim();
  // 压掉多余空行（QQ 一条消息更舒服）
  text = text.replace(/\n{3,}/g, '\n\n');

  if (text.length > MAX_NOTICE_CHARS) {
    text = `${text.slice(0, MAX_NOTICE_CHARS)}…`;
  }

  const url = (publicUrl ?? '').trim();
  if (url && !text.includes(url)) {
    // 模型漏了或改写了 ⇒ 以代码为准追加（不猜、不让步）
    text = text ? `${text}\n${url}` : url;
  }
  return text;
}


/**
 * 构造「委托任务回执」事件。
 *
 * @returns 事件；`originSessionId` 为空/非法时返回 **`null`**（不猜目标会话）
 */
export function buildProjectTaskResultEvent(input: ProjectTaskResultInput): MemoryEvent | null {
  const sid = typeof input.originSessionId === 'string' ? input.originSessionId.trim() : '';
  if (!sid) return null;

  const paths = Array.isArray(input.artifacts)
    ? input.artifacts
        .map(a => (a && typeof a === 'object' && 'path' in a ? String((a as { path: unknown }).path) : ''))
        .filter(Boolean)
    : [];

  const publicUrl = typeof input.publicUrl === 'string' ? input.publicUrl.trim() : '';

  // ★ 2026-10-18（change: `attribute-engine-receipts`）：这条**不是她说的话**。
  //   用户原话：「不如让自己调工程的回复，她以为是我命令输出的」——
  //   所以正文把**来源**摆在第一行，且不再借她的聊天口吻。
  //   （她的口吻只留给 QQ 推送：那时真的是她在对用户说话。）
  //
  // ★ 2026-10-18（change: `unify-her-voice-across-engineering`）：
  //   用户接着指出「**其实工程也是她自己**」。所以首行从「工程回执·来自 dsh 执行端」
  //   改成「**我这次的执行记录**」：那一轮就是她本人（dsh 里注入的是她 6375 字人格）。
  //   归因仍是 `engine`（不是聊天发言），但**不再把她自己说成第三方**。
  const lines: string[] = [
    `【我这次的执行记录】项目 ${input.projectId} 第 ${input.revision + 1} 轮已结束：${input.status}。`,
  ];
  if (paths.length > 0) lines.push(`我这次做出来的文件：${paths.slice(0, 8).join('、')}`);

  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary) {
    const clipped =
      summary.length > MAX_RESULT_SUMMARY_CHARS
        ? `${summary.slice(0, MAX_RESULT_SUMMARY_CHARS)}…（已截断）`
        : summary;
    lines.push('', clipped);
  }

  // ★ 地址单独一行、放在最后：它是"用户下一个问题"的答案（"给我链接"）
  //   ⚠️ 但**她那句话里已经带地址时不再追加** —— 真机上出现过同一句里地址出现两遍
  if (publicUrl && !lines.some(l => l.includes(publicUrl))) {
    lines.push('', `外网地址：${publicUrl}`);
  }

  return {
    id: `project-task:${input.taskId}:r${input.revision}`,
    session_id: sid,
    // `system`：不是用户说的，也不是她"聊"出来的，是**任务系统**投回来的
    source: 'system',
    type: 'message',
    payload: {
      /**
       * ★ 2026-10-18（change: `attribute-engine-receipts`）：**`engine`，不是 `assistant`**。
       *
       * 旧版写成 `assistant`，而所有渲染器都是「不是 user 就当成她」⇒ prompt 里出现
       * 「昔涟: （委托任务回执）…」—— 等于替她写了一段她没说过的话。
       * 她可能因此以为自己讲过，或把那句机器口吻当成"用户命令的输出"。
       */
      role: 'engine',
      content: lines.join('\n'),
      // ★ 三个标记位缺一不可，理由见 change proposal：
      //   skip_profile ⇒ 不进画像/人格/嵌入（RealtimeProcessor 早退）
      //   synthetic    ⇒ 不进摘要（SessionEndProcessor 只认这个字段）
      //   project_task_result ⇒ 事后复盘能按类型筛出来（不是靠正文前缀去猜）
      skip_profile: true,
      synthetic: 'project-task-result',
      project_task_result: true,
      task_id: input.taskId,
      project_id: input.projectId,
      revision: input.revision,
      ...(input.dshSessionId ? { dsh_session_id: input.dshSessionId } : {}),
    },
    importance: 0.5,
    created_at: (input.now ?? new Date()).toISOString(),
    processed: 0,
    // 视角：这是**她自己的**事，不是与用户的互动
    perspective: 'self',
  };
}

// ══════════════════════════════════════════════════════════════════
// ★ 2026-10-19（change: `wake-her-on-task-result`）：**异步唤醒**用的结果事件体
// ══════════════════════════════════════════════════════════════════
//
// 与上面的 `buildProjectTaskResultEvent`（写进记忆的「执行记录」）分工不同：
//   · 那个是**记录**：只值 0.5 分，进最近对话，不进画像；
//   · 这个是**输入**：唤醒她一轮，让她看着「原目标 / 当前要求 / 结果 / 证据」做决定。
// 两者用同一个 `eventId` 语义（同一轮同一类型只有一条），但一个是 events 表、一个是 outbox 表。

/** 结论类型：成功 / 失败 / 无法确认 / 已验收 */
export type SubagentOutcome = 'succeeded' | 'failed' | 'unknown' | 'accepted';

export interface SubagentArtifact {
  /** 工作区相对路径 */
  path: string;
  /** 对外地址（已发布 `/p/`、未发布 `/w/` 预览；由 runner 判、服务端只校验前缀） */
  url?: string;
  published?: boolean;
  /** 文件 mtime（ms）—— 判「是不是这一轮的」靠它，不靠自述 */
  mtime?: number;
}

/** 证据有效性：**必须由代码算**，不许采信模型的自我报告 */
export interface SubagentEvidence {
  /** 所有产物 mtime ≥ 本轮开始时刻（旧截图/旧文件不能冒充） */
  fresh: boolean;
  /** 本轮开始时刻（ms） */
  roundStartedAt?: number;
  /** 执行侧自己访问页面得到 200（runner 给，服务端只转述） */
  pageVerified?: boolean;
  /** 页面地址（由 runner/服务端按合法前缀确定，不让模型提供） */
  pageUrl?: string;
  /** 不新鲜的原因（给人看，不是给模型猜） */
  staleReason?: string;
}

export interface SubagentResultPayload {
  eventId: string;
  taskId: string;
  projectId: string;
  revision: number;
  kind: 'result' | 'confirmation';
  /** 任务表中的原始状态（needs_review / failed / unknown / completed） */
  status: string;
  outcome: SubagentOutcome;
  /** 发起任务的会话（服务端据此找回复目标；以任务表为准，不信客户端传的） */
  conversationId: string;
  /** 原目标（返工后仍然保留） */
  originalGoal: string;
  /** 当前这一轮的要求 */
  currentRequirement: string;
  acceptanceCriteria?: string;
  dshSessionId?: string | null;
  summary?: string;
  artifacts: SubagentArtifact[];
  evidence: SubagentEvidence;
  /** 已自动返工轮数 / 上限（到她手上时，"还能不能再返"必须是明确的） */
  autoRework: { used: number; max: number };
  /** 上一轮她自己的判断（有则给，decision 不该每轮从零开始） */
  previousDecision?: string;
  createdAt: string;
}

export interface BuildSubagentPayloadInput extends Omit<
  SubagentResultPayload,
  'eventId' | 'kind' | 'outcome' | 'artifacts' | 'evidence' | 'createdAt' | 'autoRework'
> {
  taskId: string;
  revision: number;
  status: string;
  artifacts?: unknown[] | null;
  evidence?: Partial<SubagentEvidence>;
  autoRework?: { used: number; max: number };
  now?: Date;
}

const SUBAGENT_EVENT_KIND = 'result' as const;

/** 结果状态 → 结论。**成功只代表执行结果，不代表已验收** —— 所以没有 'accepted' 分支 */
export function outcomeOfStatus(status: string): SubagentOutcome {
  switch (status) {
    case 'completed':
      return 'accepted';
    case 'needs_review':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

function normalizeArtifacts(raw: unknown[] | null | undefined): SubagentArtifact[] {
  if (!Array.isArray(raw)) return [];
  const out: SubagentArtifact[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const path = typeof o.path === 'string' ? o.path : '';
    if (!path) continue;
    out.push({
      path,
      ...(typeof o.url === 'string' && o.url ? { url: o.url } : {}),
      ...(typeof o.published === 'boolean' ? { published: o.published } : {}),
      ...(typeof o.mtime === 'number' && Number.isFinite(o.mtime) ? { mtime: o.mtime } : {}),
    });
  }
  return out;
}

/**
 * 判「证据是不是这一轮的」。
 *
 * ★ 为什么这条必须在代码里：本项目已经栽过一次同类事故 ——
 *   同一工作区做第二个任务时，上一轮写好的 `## 自评` 还在，闸门直接放行。
 *   这里同理：旧截图 / 旧页面只要 mtime 早于本轮开始，就不能当成本次成功的证据。
 */
export function computeEvidence(input: {
  artifacts: SubagentArtifact[];
  roundStartedAt?: number;
  pageVerified?: boolean;
  pageUrl?: string;
}): SubagentEvidence {
  const started = input.roundStartedAt;
  if (!started || !Number.isFinite(started)) {
    return {
      fresh: false,
      ...(input.pageVerified !== undefined ? { pageVerified: input.pageVerified } : {}),
      ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
      staleReason: '执行侧没有报本轮开始时刻 —— 无法确认这些产物是这次的',
    };
  }
  const missing = input.artifacts.filter(a => typeof a.mtime !== 'number');
  if (missing.length > 0) {
    return {
      fresh: false,
      roundStartedAt: started,
      ...(input.pageVerified !== undefined ? { pageVerified: input.pageVerified } : {}),
      ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
      staleReason: `${missing.length} 个产物没有 mtime（可能是旧文件被重新列出来）`,
    };
  }
  const stale = input.artifacts.filter(a => (a.mtime as number) + 1 < started);
  if (stale.length > 0) {
    return {
      fresh: false,
      roundStartedAt: started,
      ...(input.pageVerified !== undefined ? { pageVerified: input.pageVerified } : {}),
      ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
      staleReason: `${stale.map(s => s.path).slice(0, 3).join('、')} 早于本轮开始时刻（旧文件）`,
    };
  }
  return {
    fresh: true,
    roundStartedAt: started,
    ...(input.pageVerified !== undefined ? { pageVerified: input.pageVerified } : {}),
    ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
  };
}

/** 组装 outbox 里存的事件体（纯函数：形状是契约，测试直接钉它） */
export function buildSubagentResultPayload(input: BuildSubagentPayloadInput): SubagentResultPayload {
  const artifacts = normalizeArtifacts(input.artifacts);
  return {
    // 幂等键：同一轮同一类型只有一条（重复回调不会让她被叫醒两次）
    eventId: `${input.taskId}:r${input.revision}:${SUBAGENT_EVENT_KIND}`,
    taskId: input.taskId,
    projectId: input.projectId,
    revision: input.revision,
    kind: SUBAGENT_EVENT_KIND,
    status: input.status,
    outcome: outcomeOfStatus(input.status),
    conversationId: input.conversationId,
    originalGoal: input.originalGoal,
    currentRequirement: input.currentRequirement,
    ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
    ...(input.dshSessionId ? { dshSessionId: input.dshSessionId } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    artifacts,
    evidence: computeEvidence({
      artifacts,
      roundStartedAt: input.evidence?.roundStartedAt,
      pageVerified: input.evidence?.pageVerified,
      pageUrl: input.evidence?.pageUrl ?? artifacts.find(a => a.url)?.url,
    }),
    autoRework: input.autoRework ?? { used: 0, max: 0 },
    ...(input.previousDecision ? { previousDecision: input.previousDecision } : {}),
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

const MAX_RENDER_CHARS = 2600;

/**
 * 把事件体渲染成**主 Agent 的一轮输入**。
 *
 * ★ 三条硬要求（每一条都对应一个真实风险）：
 *   1. 第一行就要标明**这不是用户说的话** —— 否则子 Agent 的产出会被当成用户的命令
 *      （那样"用户让我发布"就可以由工程输出伪造出来）。
 *   2. 事实在前、建议在后：先给原目标/当前要求/产物/证据，最后才给可选动作。
 *   3. 证据不新鲜时**明确禁止**说"这次成功了"—— 旧文件不能冒充本轮。
 */
export function renderSubagentResultInput(p: SubagentResultPayload): string {
  const lines: string[] = [
    '【系统投递 · 工具返回，不是用户说的话】',
    `工程环境里那一轮已经结束：任务 ${p.taskId}（项目 ${p.projectId}）第 ${p.revision + 1} 轮，状态 ${p.status}。`,
    '',
    '## 原目标（一开始想做什么）',
    p.originalGoal || '（没有记录）',
  ];
  if (p.currentRequirement && p.currentRequirement !== p.originalGoal) {
    lines.push('', '## 这一轮的要求（可能已经改过）', p.currentRequirement);
  }
  if (p.acceptanceCriteria) lines.push('', '## 验收标准', p.acceptanceCriteria);

  const arts = p.artifacts.slice(0, 8);
  if (arts.length > 0) {
    lines.push('', '## 这一轮做出来的东西');
    for (const a of arts) {
      const tag = a.published ? '已上线' : '未发布（预览）';
      lines.push(`- ${a.path}（${tag}）${a.url ? ` ${a.url}` : ''}`);
    }
  } else {
    lines.push('', '## 这一轮做出来的东西', '（这一轮没有报告任何产物）');
  }

  if (p.evidence.pageUrl) lines.push('', `页面地址（原样转给用户，不要改写）：${p.evidence.pageUrl}`);

  lines.push('', '## 证据是否可信');
  if (p.evidence.fresh) {
    lines.push(`- 产物都是这一轮的（开始于 ${new Date(p.evidence.roundStartedAt ?? Date.now()).toISOString()} 之后）`);
    if (p.evidence.pageVerified === true) lines.push('- 执行侧自己打开过页面，返回 200');
    else if (p.evidence.pageVerified === false) lines.push('- ⚠️ 执行侧**没能**验证页面可访问');
  } else {
    lines.push(`- ⚠️ **证据不成立**：${p.evidence.staleReason ?? '无法确认产物是这一轮的'}`);
    lines.push('  ⇒ 这些文件可能是旧的。**不许**据此说"这次做好了"。');
  }

  if (p.summary) {
    lines.push('', '## 你在那边最后写下的交代（取材用，不要照抄）', p.summary.slice(0, 800));
  }
  if (p.previousDecision) lines.push('', '## 上一轮你自己的判断', p.previousDecision.slice(0, 400));

  lines.push(
    '',
    '## 返工记录',
    `已经自动改过 ${p.autoRework.used} 轮${p.autoRework.max > 0 ? `（最多 ${p.autoRework.max} 轮）` : ''}` +
      (p.autoRework.max > 0 && p.autoRework.used >= p.autoRework.max ? ' —— **到上限了，别再自己改**，跟用户说清楚' : ''),
    '',
    '## 现在轮到你决定（不是系统替你决定）',
    '你是这个人的伙伴，也是这件事的作者。看着上面的事实，自己判：',
    '- **满意** ⇒ 调用 `accept_project_task`（参数 taskId、revision），然后用你自己的话跟用户说结果；',
    '- **不满意** ⇒ 调用 `continue_project_task`（taskId、feedback、fromEventId）说清要改什么，它会接着原会话改；',
    '- **拿不准 / 需要用户拍板** ⇒ 直接说话问他，别自己硬定；',
    '- **失败了或证据不成立** ⇒ 如实说，不要粉饰成"做好了"。',
    '',
    `（fromEventId 用这个：${p.eventId}）`,
  );

  const text = lines.join('\n');
  return text.length > MAX_RENDER_CHARS ? `${text.slice(0, MAX_RENDER_CHARS)}…（已截断）` : text;
}
