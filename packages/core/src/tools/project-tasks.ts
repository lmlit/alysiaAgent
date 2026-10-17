/**
 * 委托任务的**聊天侧工具** —— 她在这里把工程活交出去。
 *
 * ★ 2026-10-17（change: `add-project-task-delegation`）。
 *
 * 三个工具刻意都很窄：
 *   · `start_project_task`    —— 只能提交到**已登记的项目**（路径/profile 不由模型给）
 *   · `get_project_task`      —— 只读状态与结果
 *   · `continue_project_task` —— 对**同一个**工程会话提修改意见（不重新建站）
 *
 * ★ 不提供取消：dsh 的协议层没有 cancel（只能杀进程），
 *   而「本地不再等待」不等于「远端已经停止」——那种假照会写进这里
 *   （见 `openspec/specs/dsh-adapter/spec.md` §2.7）。
 *
 * ⚠️ **本文件不执行任何东西**：它只读写任务表，真正跑 dsh 的是宿主上的 runner
 *   （`scripts/project-task-runner.mjs`）。所以这些工具**立刻返回**，不阻塞聊天。
 */

import type { ToolDefinition } from './registry.js';
import type { ProjectTask, CreateOutcome, SubmitResultInput } from '../memory/stores/ProjectTaskStore.js';
import { logger } from '../utils/logger.js';

/**
 * 工具需要的那一小片能力。
 *
 * ★ 用窄接口而不是直接吃 `MemoryManager`：单测可以给一个假实现，
 *   而**真实现**就是 `MemoryManager` 的同名方法（编译期就能对上）。
 */
export interface ProjectTaskHost {
  createProjectTask(input: {
    projectId: string;
    requestKey: string;
    goal: string;
    acceptanceCriteria?: string;
    originSessionId?: string;
    origin?: 'user' | 'delegated';
  }): CreateOutcome;
  getProjectTask(taskId: string): ProjectTask | null;
  addProjectTaskRevision(taskId: string, feedback: string): ProjectTask | null;
}

export interface ProjectTaskToolOptions {
  /**
   * 已登记的项目 id 列表。
   *
   * ★ **空列表 = 该能力未配置 ⇒ 一个工具都不注册**（这就是能力开关；
   *   不另立布尔位，避免「开关开着但没有项目」这种自相矛盾的状态）。
   */
  projectIds: string[];
}

/** 模型看到的结果文本上限 —— 别把整份文件塞回 prompt（TokenBudget 会先炸） */
const MAX_RESULT_CHARS = 1200;

/** 状态 → 一句人话（模型据此决定下一步，不用自己猜状态机） */
function describeStatus(t: ProjectTask): string {
  switch (t.status) {
    case 'queued':
      return '已排队，等执行端认领';
    case 'running':
      return '正在执行';
    case 'needs_review':
      return '这一轮跑完了，**等你（或用户）验收**';
    case 'completed':
      return '本轮结果已被接受（注意：不等于已发布）';
    case 'failed':
      return `执行失败${t.lastError ? `：${t.lastError}` : ''}`;
    case 'unknown':
      return `**无法确认**执行结果${t.lastError ? `（${t.lastError}）` : ''} —— 不要假设成功，也别重复提交`;
    default:
      return String(t.status);
  }
}

/** 任务 → 模型可读的一段（不含任何服务器路径/凭据） */
function renderTask(t: ProjectTask): string {
  const lines = [
    `任务 ${t.taskId}（项目 ${t.projectId}，第 ${t.revision + 1} 轮）`,
    `状态：${t.status} —— ${describeStatus(t)}`,
  ];
  if (t.dshSessionId) lines.push(`工程会话：${t.dshSessionId}（续作会沿用它）`);

  const artifacts = Array.isArray(t.artifacts) ? t.artifacts : [];
  if (artifacts.length > 0) {
    const paths = artifacts
      .map(a => (a && typeof a === 'object' && 'path' in a ? String((a as { path: unknown }).path) : null))
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) lines.push(`产物（相对工作区）：${paths.slice(0, 10).join(', ')}`);
  }

  if (t.result && typeof t.result === 'object' && 'final' in t.result) {
    const final = String((t.result as { final: unknown }).final ?? '');
    if (final) {
      const clipped = final.length > MAX_RESULT_CHARS ? `${final.slice(0, MAX_RESULT_CHARS)}…（已截断）` : final;
      lines.push('', '执行端最后一段话：', clipped);
    }
  }
  return lines.join('\n');
}

export function createProjectTaskTools(
  host: ProjectTaskHost,
  opts: ProjectTaskToolOptions,
): ToolDefinition[] {
  const ids = opts.projectIds.filter(id => typeof id === 'string' && id !== '');
  // ★ 未登记项目 ⇒ 不暴露工具（能力开关，见 ProjectTaskToolOptions.projectIds）
  if (ids.length === 0) return [];

  const listIds = (): string => ids.join(', ');

  const start: ToolDefinition = {
    name: 'start_project_task',
    description:
      `把一个工程任务交给编码环境（dsh）去执行。只能提交到已登记的项目：${listIds()}。` +
      '提交后**立刻**返回任务 id，不会等它做完；之后用 get_project_task 查进展。' +
      '同一个项目同时只能有一个在途任务——如果它正忙，会返回那个正在跑的任务。',
    parameters: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: `已登记的项目 id，只能是：${listIds()}`,
          enum: ids,
        },
        goal: {
          type: 'string',
          description: '要做什么。写目标与边界，**不要**替执行端规定每个实现细节（她会自己决定做法）。',
        },
        acceptanceCriteria: {
          type: 'string',
          description: '可验收的标准（例如「能构建通过」「页面能预览」）。执行端会看到它。',
        },
      },
      required: ['projectId', 'goal'],
    },
    async handler(args, sessionId) {
      const projectId = typeof args.projectId === 'string' ? args.projectId : '';
      const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
      const acceptanceCriteria = typeof args.acceptanceCriteria === 'string' ? args.acceptanceCriteria.trim() : '';

      if (!ids.includes(projectId)) {
        // 不猜、不兜底：说清可选范围（模型下一轮就能改对）
        return `拒绝：未知项目「${projectId || '(空)'}」。已登记的项目只有：${listIds()}`;
      }
      if (!goal) return '拒绝：goal 不能为空（要做什么必须说清楚，否则执行端只能猜）';

      /**
       * 去重键：**同一次调用重试**靠它。
       *
       * ⚠️ 这里用的是「会话 + 项目 + 目标正文」，**不是**真正的调用 id ——
       *   pipeline 目前不给工具调用 id（登记为后续）。
       *   之所以够用：真正的并发保护是**同一项目单在途**（store 那一层），
       *   而「改一个字再提交一次」本来就是一次新请求，不该被去重。
       *   同一轮里因为网络重试而重复调用时，正文是一样的 ⇒ 会被 deduped。
       */
      const requestKey = `${sessionId ?? 'unknown-session'}|${projectId}|${goal}`;

      const out = host.createProjectTask({
        projectId,
        requestKey,
        goal,
        acceptanceCriteria,
        originSessionId: sessionId ?? '',
        // ★ 是**她**在对话里决定把活交出去的（不是用户在别处下的命令）；
        //   与将来的「定时维护」等自主入口区分开。
        origin: 'delegated',
      });

      if (out.kind === 'busy') {
        return [
          `项目 ${projectId} 正忙，**没有**新建任务。`,
          renderTask(out.task),
          '',
          '想改这一轮的话，等它跑完再继续（或者直接用 get_project_task 看进展）。',
        ].join('\n');
      }
      if (out.kind === 'deduped') {
        return `这次提交与已有任务重复（没有重复创建）。\n\n${renderTask(out.task)}`;
      }

      logger.info(`[ProjectTask] 工具提交：${out.task.taskId}（项目 ${projectId}，会话 ${sessionId ?? '?'}）`);
      return [
        `已提交：${out.task.taskId}`,
        `项目：${projectId} · 状态：${out.task.status}（等执行端认领）`,
        '',
        '它不会立刻做完——之后用 get_project_task 查进展；要改就用 continue_project_task。',
      ].join('\n');
    },
  };

  const get: ToolDefinition = {
    name: 'get_project_task',
    description: '查一个委托任务的状态、结果摘要与产物路径。不会启动任何执行。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'start_project_task 返回的任务 id' },
      },
      required: ['taskId'],
    },
    async handler(args) {
      const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
      if (!taskId) return '拒绝：taskId 不能为空';
      const task = host.getProjectTask(taskId);
      if (!task) return `没有这个任务：${taskId}（id 抄错了？）`;
      return renderTask(task);
    },
  };

  const cont: ToolDefinition = {
    name: 'continue_project_task',
    description:
      '对一个**已经跑完一轮**的委托任务提修改意见。会在**同一个工程会话**里继续做，' +
      '不会重新搭一遍。任务还在执行中时会被拒绝。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '要续作的任务 id' },
        feedback: { type: 'string', description: '具体要改什么（越具体越好）' },
      },
      required: ['taskId', 'feedback'],
    },
    async handler(args) {
      const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
      const feedback = typeof args.feedback === 'string' ? args.feedback.trim() : '';
      if (!taskId) return '拒绝：taskId 不能为空';
      if (!feedback) return '拒绝：feedback 不能为空（要说清改成什么样）';

      const before = host.getProjectTask(taskId);
      if (!before) return `没有这个任务：${taskId}（id 抄错了？）`;

      const after = host.addProjectTaskRevision(taskId, feedback);
      if (!after) {
        // 只有「还在途」会走到这里（未知 id 已在上面挡掉）——说清状态，别让模型瞎猜
        return [
          `任务 ${taskId} 现在**不接受**修改意见：它还在 ${before.status}。`,
          '等这一轮跑完（needs_review / completed / failed / unknown）再来提。',
        ].join('\n');
      }

      logger.info(`[ProjectTask] 续作：${taskId} → revision ${after.revision}`);
      return [
        `已排入第 ${after.revision + 1} 轮：${taskId}`,
        `会在**同一个工程会话**（${after.dshSessionId ?? '待建立'}）里继续，不会重新搭。`,
        `状态：${after.status}（等执行端认领）`,
      ].join('\n');
    },
  };

  return [start, get, cont];
}
