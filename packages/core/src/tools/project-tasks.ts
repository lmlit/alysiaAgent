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
import { computeTaskWindow, type TaskWindowInput } from '../memory/project-task-window.js';

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
    /** ★ 2026-10-19：`build`（六阶段） / `action`（单轮） */
    kind?: 'build' | 'action';
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
  /**
   * 执行窗口（★ 2026-10-18，change: `gate-project-tasks-to-offpeak`）。
   *
   * 高峰时段提交**不拒绝**，只在回执里告诉她"到点自己会跑" ——
   * 拒收等于让她记住时段，而排队不花钱、执行才花钱。
   */
  taskWindow?: TaskWindowInput;
  /**
   * ★ 2026-10-19（change: `let-her-query-what-she-made`）：**她做过哪些页面**的只读清单。
   *
   * 真机事故：用户问"给我链接"，她**新建了一个任务**去核实地址
   * （`15:53 核实 island.html 当前真实的对外可访问地址…`）。
   * 那件事该用**查询**，不该开一个会跑 dsh、会花钱、还会写工作区的任务。
   *
   * 数据来自宿主 runner 推上来的 `pages.json`（容器看不到宿主目录）。
   * 不给 provider ⇒ 这两个查询工具不注册（保持"没数据就别给她假能力"）。
   */
  pages?: PagesProvider;
}

/**
 * 页面清单提供者（★ 2026-10-19，change: `let-her-query-what-she-made`）。
 * 返回 `null` = 现在读不到（宿主还没推 / 生成器没跑）—— 工具要**如实说**，不许假装知道。
 */
export type PagesProvider = () => {
  generatedAt: string;
  receivedAt?: string;
  pages: Array<{
    projectId: string;
    file: string;
    title: string;
    url: string;
    published: boolean;
    updatedAt: string;
  }>;
} | null;

/** 模型看到的结果文本上限 —— 别把整份文件塞回 prompt（TokenBudget 会先炸） */
const MAX_RESULT_CHARS = 1200;

/** 状态 → 一句人话（模型据此决定下一步，不用自己猜状态机） */
function describeStatus(t: ProjectTask): string {
  switch (t.status) {
    case 'queued':
      return '已排队（宿主 runner 会来认领）';
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

/**
 * 任务 → 模型可读的一段（不含任何服务器路径/凭据）。
 *
 * ★ 2026-10-18（change: `unify-her-voice-across-engineering`）：
 *   ① 措辞改第一人称 ——「你那一轮」而不是「执行端」（那一轮是她自己）
 *   ② **带地址**：`artifacts[].url` 由 runner 从 `publicUrl` 派生（契约 38c），
 *      以前只给相对路径 ⇒ 用户问"给我链接"时她只能凭空拼 `/p/<项目>/<文件名>`，
 *      而未发布时那条路是 404。地址由代码给，她只负责原样抄（契约 26）。
 */
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
    if (paths.length > 0) lines.push(`你这一轮做出来的文件（相对工作区）：${paths.slice(0, 10).join(', ')}`);

    // ★ 地址：**只抄不拼**。优先给第一个带 url 的产物（= 本轮那个页面）
    const url = artifacts
      .map(a => (a && typeof a === 'object' && 'url' in a ? String((a as { url: unknown }).url ?? '') : ''))
      .map(u => u.trim())
      .find(u => u.length > 0);
    if (url) lines.push(`页面地址（原样转给用户，不要改写）：${url}`);
  }

  if (t.result && typeof t.result === 'object' && 'final' in t.result) {
    const final = String((t.result as { final: unknown }).final ?? '');
    if (final) {
      const clipped = final.length > MAX_RESULT_CHARS ? `${final.slice(0, MAX_RESULT_CHARS)}…（已截断）` : final;
      lines.push('', '你那一轮最后写下的交代：', clipped);
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
      `在工程环境里**自己**去做一件事（同一个你，只是换了个干活的场所 —— 不是派人，也不是另一个角色）。` +
      `只能提交到已登记的项目：${listIds()}。` +
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
          description: '要做什么。写目标与边界，**不要**替那一轮的你规定每个实现细节——到了那边你会自己决定做法。',
        },
        acceptanceCriteria: {
          type: 'string',
          description: '可验收的标准（例如「能构建通过」「页面能预览」）。你在那条任务里会看到它。',
        },
        kind: {
          type: 'string',
          enum: ['build', 'action'],
          description:
            '这条任务是什么类型。**build**（默认）= 做一件新东西（新页面/新玩具/重做一版），'
            + '会走「先想→画草图→自评→做完整版→改一轮→说出哪里像我」的来回；'
            + '**action** = 做一件事（发布某个页面、核实一个地址、改一处小地方），'
            + '**单轮做完就交**，不会要求你写意图/草图。选错了只会让你白跑几轮，别乱选。',
        },
      },
      required: ['projectId', 'goal'],
    },
    async handler(args, sessionId) {
      const projectId = typeof args.projectId === 'string' ? args.projectId : '';
      const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
      const acceptanceCriteria = typeof args.acceptanceCriteria === 'string' ? args.acceptanceCriteria.trim() : '';
      const kind = args.kind === 'action' ? 'action' : 'build';

      if (!ids.includes(projectId)) {
        // 不猜、不兜底：说清可选范围（模型下一轮就能改对）
        return `拒绝：未知项目「${projectId || '(空)'}」。已登记的项目只有：${listIds()}`;
      }
      if (!goal) return '拒绝：goal 不能为空（要做什么必须说清楚，否则到了那边你只能猜）';

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
        // ★ 2026-10-19：任务类型决定"要不要来回六轮"（详见参数说明）
        kind,
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

      // ★ 2026-10-18（change: `gate-project-tasks-to-offpeak`）：
      //   高峰时段提交**不拒绝**（拒收等于让她记住时间），而是告诉她"到点自己会跑"。
      //   钱按实际执行时间算，排队本身不花。
      const w = computeTaskWindow(opts.taskWindow);
      const lines = [
        `已提交：${out.task.taskId}`,
        `项目：${projectId} · 状态：${out.task.status}（已排队，宿主 runner 会来认领）`,
      ];
      if (!w.offPeak) {
        lines.push('', `⏳ ${w.message}`);
      }
      lines.push(
        '',
        '它不会立刻做完——之后用 get_project_task 查进展；要改就用 continue_project_task。',
      );
      return lines.join('\n');
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
        `状态：${after.status}（已排队，宿主 runner 会来认领）`,
      ].join('\n');
    },
  };

  /**
   * ★ 2026-10-19（change: `let-her-query-what-she-made`）：**只读查询**她做过的页面。
   *
   * 为什么要有：用户问"给我链接"，她只能**新建一个任务**去核实（真机证据在
   * `ProjectTaskToolOptions.pages` 的注释里）。那是用"再造一次"来回答"在哪"——
   * 既慢又花钱，而且会往工作区写东西。查一下就够了。
   *
   * 只读、无副作用：不建任务、不跑 dsh、不写文件。
   */
  const pageLine = (p: { title: string; url: string; published: boolean; updatedAt: string }) =>
    `- ${p.title}${p.published ? '' : '（预览）'} → ${p.url}` +
    `${p.updatedAt ? ` · 更新于 ${p.updatedAt.replace('T', ' ').slice(0, 16)}` : ''}`;

  /** 清单的"多旧"提示 —— 她是拿它回答用户的，别把旧数据说成现况 */
  const freshness = (idx: { generatedAt: string; receivedAt?: string }): string => {
    if (!idx.receivedAt) return '';
    const min = Math.floor((Date.now() - Date.parse(idx.receivedAt)) / 60000);
    if (!Number.isFinite(min) || min < 2) return '';
    return `（这份清单是 ${min} 分钟前从宿主机收到的；要最新就以基站 /pages 为准）`;
  };

  const listPages: ToolDefinition = {
    name: 'list_my_pages',
    description:
      '查**你自己做过哪些页面**（只读，不建任务、不跑执行端、不花时间也不花钱）。'
      + '用户问「你都做过些什么」「上次那页呢」「全部在哪看」时用这个。'
      + '每一条给标题、地址、是否已上线、更新时间；已上线的地址是 /p/…，没上线的走只读预览 /w/…。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '可选：只看某个项目（不填=全部）' },
        limit: { type: 'number', description: '最多几条（默认 20）' },
      },
      required: [],
    },
    async handler(args) {
      const idx = opts.pages?.() ?? null;
      if (!idx) {
        return '现在读不到页面清单（宿主 runner 还没推上来 / 基站生成器没在跑）——'
          + '这种情况可以给基站总入口给用户，或者用 get_project_task 查具体某一轮。';
      }
      const pid = typeof args.projectId === 'string' ? args.projectId.trim() : '';
      const limitRaw = typeof args.limit === 'number' ? args.limit : 20;
      const limit = Math.min(Math.max(1, Math.trunc(limitRaw)), 50);
      const all = idx.pages.filter(p => (pid ? p.projectId === pid : true));
      if (all.length === 0) return pid ? `项目 ${pid} 下没有页面记录。` : '清单里还没有任何页面。';
      const shown = all.slice(0, limit);
      return [
        `你做过 ${all.length} 个页面${pid ? `（项目 ${pid}）` : ''}${freshness(idx)}：`,
        ...shown.map(pageLine),
        ...(all.length > shown.length ? [`…还有 ${all.length - shown.length} 个，用 limit 取更多`] : []),
        '',
        '要链接就直接把上面那条地址给用户 —— **不要**为了一个网址去新建任务。',
      ].join('\n');
    },
  };

  const findPage: ToolDefinition = {
    name: 'find_page',
    description:
      '按名字/关键词找**你自己做过的某一页**（只读）。用户说「海那页」「慢时钟」「那个日记」时用这个，'
      + '拿到地址直接给他。**不要**为了查地址去 start_project_task。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词：文件名（island）、标题词（海岛/慢时钟/随笔）都行' },
      },
      required: ['query'],
    },
    async handler(args) {
      const idx = opts.pages?.() ?? null;
      if (!idx) return '现在读不到页面清单（宿主的清单还没推上来）。可以先给基站总入口，或用 get_project_task 查那轮。';
      const q = String((args as { query?: unknown })?.query ?? '').trim().toLowerCase();
      if (!q) return '拒绝：query 不能为空';
      const hit = idx.pages.filter(p =>
        p.file.toLowerCase().includes(q) || p.title.toLowerCase().includes(q) || p.projectId.toLowerCase().includes(q),
      );
      if (hit.length === 0) {
        return `没找到和「${q}」对得上的页面（共 ${idx.pages.length} 页）。`
          + '可以换关键词，或用 list_my_pages 看全部 —— 真没有才是要做新的。';
      }
      return [
        `找到 ${hit.length} 个${freshness(idx) ? ` ${freshness(idx)}` : '（清单较新）'}：`,
        ...hit.slice(0, 5).map(pageLine),
        ...(hit.length > 5 ? [`…还有 ${hit.length - 5} 个`] : []),
      ].join('\n');
    },
  };

  const withPages = opts.pages ? [listPages, findPage] : [];
  return [start, get, cont, ...withPages];
}
