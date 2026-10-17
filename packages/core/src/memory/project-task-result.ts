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

  const lines = [
    `（委托任务回执）项目 ${input.projectId} 第 ${input.revision + 1} 轮已结束：${input.status}。`,
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
  const publicUrl = typeof input.publicUrl === 'string' ? input.publicUrl.trim() : '';
  if (publicUrl) lines.push('', `外网地址：${publicUrl}`);

  return {
    id: `project-task:${input.taskId}:r${input.revision}`,
    session_id: sid,
    // `system`：不是用户说的，也不是她"聊"出来的，是**任务系统**投回来的
    source: 'system',
    type: 'message',
    payload: {
      role: 'assistant',
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
