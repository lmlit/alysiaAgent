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

export interface ProjectTaskResultInput {
  taskId: string;
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
    `你叫${name}，正在跟用户说话。刚刚有一件交给工程环境的活儿跑完了一轮，你要**用你自己的口吻**告诉用户结果。`,
    '',
    '要求：',
    '- 2~3 句，一句话也行；不要列表、不要小标题、不要「回执」这类机器词。',
    '- 用你平常说话的样子（温柔、口语、偶尔一句小小的自嘲或俏皮都可以），但别演过头。',
    '- **像你平时发消息那样**：如果下面给了「最近对话」，就顺着你刚才的语气和称呼说，别突然变成另一个人。',
    '- 只说**事实里有的**：不要编造完成情况、不要替用户验收、不要承诺没做的事。',
    '- 如果这一轮其实失败了或结果不明，要如实说，不许粉饰成"做好了"。',
    '- 如果给了访问地址，**把它原样抄一遍**（一个字符都不要改），放在最后。',
    '- 不要提"委托任务""任务表""状态机"这类内部概念。',
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
  if (paths.length > 0) facts.push(`产出的文件：${paths.slice(0, 8).join('、')}`);
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary) {
    facts.push('', '工程环境那边最后说的话（可以取材，但要用你自己的语气重说）：', summary.slice(0, 600));
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
  //   所以正文以「工程回执」开头，把来源摆在第一行，且不再借她的口吻。
  //   （她的口吻只留给 QQ 推送：那时真的是她在对用户说话。）
  const lines: string[] = [
    `【工程回执·来自 dsh 执行端】项目 ${input.projectId} 第 ${input.revision + 1} 轮已结束：${input.status}。`,
  ];
  if (paths.length > 0) lines.push(`产物：${paths.slice(0, 8).join('、')}`);

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
