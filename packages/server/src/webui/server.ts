/**
 * WebUI 管理面板 —— Fastify 路由层
 *
 * 每条路由直接包装 core 的公开方法。路由的存在 = 对应 core 方法的真实调用方，
 * 验证接口可用（不依赖闭包/私有状态），确保后续 Web 前端开发不会返工。
 *
 * 路由列表：
 *   GET  /api/health              — 健康检查
 *   GET  /api/sessions            — 会话列表
 *   GET  /api/profile             — 画像快照
 *   GET  /api/persona             — 人格状态
 *   GET  /api/persona/prompt      — 人设文本（紧凑形式；dsh 动态人设的读通道）
 *   POST /api/ingest              — 喂入外部会话事件（仅 dsh: 前缀；dsh 记忆回传的写通道）
 *   GET  /api/stats               — Token 用量（全局 + 分会话）
 *   GET  /api/roles               — 角色列表
 *   GET  /api/roles/active        — 当前激活角色摘要
 *   GET  /api/roles/:id/export    — 导出角色包
 *   GET  /api/knowledge           — 知识库文档列表
 *   GET  /api/stickers            — 表情包列表
 *   POST /api/sessions/:id/extract   — 手动提取画像（LLM 异步）
 *   POST /api/roles/switch         — 切换激活角色
 *   POST /api/roles/import         — 导入角色包
 *   POST /api/persona/adjust       — 手动调整人格参数
 *   POST /api/knowledge/import     — 导入知识
 *   DELETE /api/knowledge/:id      — 删除知识文档
 *   POST /api/privacy              — 隐私模式开关
 *   GET  /api/life                 — AI 生活状态快照 + 事件流
 *   GET  /api/worldbook            — 世界书条目列表（含 source）
 *   DELETE /api/worldbook/:id      — 删除世界书条目（用户事后改）
 *   GET  /api/life/templates       — 生活模板池列表
 *   DELETE /api/life/templates/:id — 删除生活模板（用户事后改）
 */
import Fastify from 'fastify';
import type { AlysiaCore } from '@alysia/core';
import { logger } from '@alysia/core';
import { registerChatRoutes } from './chat.js';
import { MAX_INGEST_BATCH, validateIngestEvent, normalizeIngestEvent } from '../ingest.js';
import type { MemoryEvent } from '@alysia/core/memory';
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

/** ★ 8-29 cr-p0-webui-auth：WebUI 管理面板鉴权选项
 *  requireAuth=true（服务模式）：所有 /api/* 校验 `Authorization: Bearer <token>`，
 *  缺失/错误 → 401；token 未配置 → 全拒（fail closed，杜绝零鉴权裸奔）。
 *  requireAuth=false（桌面模式，绑 127.0.0.1）：免鉴权，保持本地工具体验。
 *  /api/health 始终豁免——容器 healthcheck 无 token 可配。 */
export interface WebuiAuthOptions {
  webuiToken?: string;
  requireAuth?: boolean;
  /** ★ 9-24 console-local-serve：前端静态产物根目录（绝对路径）。
   *  传 packages/console/out = 托管 Next.js 前端（多页导出）。
   *  ★ 10-02 remove-packages-webui：旧前端包已删，不再有默认回落——
   *  不传 / 产物缺失 = 只提供 /api/*（静态路由不注册，并显式 warn，不静默）。 */
  staticDist?: string;
  /**
   * ★ 2026-10-17（change: `add-project-task-delegation`）：**委托项目登记表**。
   * 见 `packages/server/src/config.ts` 的 `projects`。
   * ⚠️ 这是**宿主侧**路径/ profile —— server 只负责**校验与转交**，自己不使用它们。
   */
  projects?: Record<string, { workspace: string; profile: string; publicUrl?: string }>;
  /**
   * 主动推送通道（`al:push`）。★ 2026-10-18（change: `return-project-task-result`）：
   * 委托任务结束后要**回到原会话告诉她**。缺省 = 无通道（桌面端/无 QQ 时），只记日志不推。
   */
  push?: {
    available: boolean;
    sendProactive(openid: string, message: string, opts?: { maxSegments?: number }): Promise<boolean>;
  };
}

export function createWebuiApp(core: AlysiaCore, opts: WebuiAuthOptions = {}) {
  const { webuiToken = '', requireAuth = false, staticDist } = opts;
  /**
   * 委托项目登记表（★ 2026-10-17，change: `add-project-task-delegation`）。
   * ⚠️ 空表 = 该能力未配置：相关端点会**响亮拒绝**并说明「已登记：无」，
   *    而不是假装受理（否则提交方以为任务排上了，其实没人会跑）。
   */
  const projects = opts.projects ?? {};
  /** 主动推送通道（可能不存在 —— 桌面端/无 QQ 时是空实现） */
  const push = opts.push;
  const app = Fastify({ logger: false });

  // ★ 8-29 cr-p0-webui-auth：auth 钩子（chat 路由 registerChatRoutes 同受保护）
  // ★ 9-24 console-local-serve 修复：原实现拦下**所有**请求，与上方声明的意图
  //   （"所有 /api/* 校验"）不符 —— 后果是浏览器导航到 `/` 拿 401，前端页面根本加载不出来
  //   （浏览器导航带不上 Authorization 头）。旧前端没暴露此问题是因为静态文件从不由 Fastify 出：
  //   本地走 vite dev，Docker 镜像里没打包 dist。
  //   现改为只守 /api/*：静态资源公开、数据仍在鉴权后 —— 标准 SPA + API 鉴权模型。
  if (requireAuth) {
    app.addHook('onRequest', async (req: any, reply: any) => {
      const path = String(req.url ?? '').split('?')[0];
      if (!path.startsWith('/api/')) return; // 静态资源/页面不鉴权
      if (path === '/api/health') return;    // 容器 healthcheck 豁免
      const auth = String(req.headers.authorization ?? '');
      if (!webuiToken || auth !== `Bearer ${webuiToken}`) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });
  }

  // ★ 8-15 WebUI 聊天端点（webui-chat-endpoints）：prompt/stream/messages/pending
  registerChatRoutes(app, core);

  // ── 系统 ──────────────────────────────────────────
  app.get('/api/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  // ★ 8-15 昔涟形象位:图形化上传/读取(存 server data/portrait.<ext>,不被 build 覆盖)
  const portraitDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../data');
  const PORTRAIT_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
  const findPortrait = (): { path: string; ext: string } | null => {
    for (const ext of PORTRAIT_EXTS) {
      const p = resolve(portraitDir, `portrait.${ext}`);
      if (existsSync(p)) return { path: p, ext };
    }
    return null;
  };
  app.get('/api/portrait', async (_req: unknown, reply: any) => {
    const found = findPortrait();
    if (!found) return reply.code(404).send({ ok: false });
    reply.type({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[found.ext] ?? 'image/png');
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send(readFileSync(found.path));
  });
  app.post('/api/portrait', async (req: any, reply: any) => {
    const { data, ext } = (req.body ?? {}) as { data?: string; ext?: string };
    if (!data || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(String(data))) {
      return reply.code(400).send({ ok: false, error: '无效图片数据' });
    }
    const buf = Buffer.from(String(data).split(',')[1], 'base64');
    if (buf.length > 8 * 1024 * 1024) return reply.code(400).send({ ok: false, error: '图片超过 8MB' });
    const extName = PORTRAIT_EXTS.includes(String(ext)) ? String(ext) : 'png';
    // 清掉旧格式,写新格式
    for (const e of PORTRAIT_EXTS) {
      const p = resolve(portraitDir, `portrait.${e}`);
      if (e !== extName && existsSync(p)) unlinkSync(p);
    }
    writeFileSync(resolve(portraitDir, `portrait.${extName}`), buf);
    logger.info(`[Portrait] updated (${buf.length} bytes, .${extName})`);
    return { ok: true, url: `/api/portrait?v=${Date.now()}` };
  });

  // ★ 8-15 WebUI 静态托管（生产形态：同源 serve 前端静态导出——assets/模型全量）
  // ★ 9-24 console-local-serve：托管 Next.js console 静态导出（多页）。
  //   路径映射见 resolveStatic：/life → life.html；未命中 → 404.html
  // ★ 10-02 remove-packages-webui：删除「不传就回落 packages/webui/dist」的默认值——
  //   旧前端包已删，回落只可能指向不存在的目录。现在：产物缺失 = 不注册静态路由，
  //   且**必须显式 warn**——静默不注册的后果是「全站 404 且一行日志都没有」
  //   （同类坑见 modules/webui.ts 文件头 / docs/dsh-migration-guide.md 坑 #2）。
  const dist = staticDist && existsSync(join(staticDist, 'index.html')) ? staticDist : null;
  if (staticDist && !dist) {
    logger.warn(`[WebUI] staticDist 缺 index.html（${staticDist}）——静态托管未启用。构建: pnpm --filter @alysia/console build`);
  }

  const MIME: Record<string, string> = {
    html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css',
    json: 'application/json', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', wasm: 'application/wasm',
    'model3.json': 'application/json', moc3: 'application/octet-stream', exp3: 'application/json',
    physics3: 'application/json', mp3: 'audio/mpeg', wav: 'audio/wav', zst: 'application/octet-stream',
    // Next.js 静态导出产物：woff2 = next/font 自托管字体；txt = RSC payload
    woff2: 'font/woff2', txt: 'text/plain; charset=utf-8', map: 'application/json',
  };

  /** 依次尝试：原路径（文件）→ path.html → path/index.html；都不中返回 null */
  function resolveStatic(pathname: string): string | null {
    if (!dist) return null;
    // 两端斜杠都要剥：Next 导出的是 `life.html`，用户手打 `/life/` 不该 404
    const clean = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    const candidates = clean
      ? [clean, `${clean}.html`, join(clean, 'index.html')]
      : ['index.html'];
    for (const rel of candidates) {
      const abs = resolve(dist, rel);
      // 防目录穿越（用 sep 收口，避免 /dist-evil 命中 /dist）
      if (abs !== dist && !abs.startsWith(dist + sep)) continue;
      if (existsSync(abs) && !statSync(abs).isDirectory()) return abs;
    }
    return null;
  }

  // Fastify v5 无 '/*' 通配路由 → 用 setNotFoundHandler 兜底静态文件(排除 /api)
  // ★ 10-02：没产物就整个不注册（上面已 warn）——不是白屏，是 /api 照常 + 页面 404
  if (dist) {
    const distRoot = dist; // 收窄进闭包（dist 在上面已判非 null）
    app.setNotFoundHandler(async (req: any, reply: any) => {
      const url = String(req?.url ?? '/').split('?')[0];
      if (url.startsWith('/api/')) {
        return reply.code(404).send({ ok: false, error: 'not found' });
      }

      let pathname: string;
      try {
        pathname = decodeURIComponent(url);
      } catch {
        // 畸形百分号编码：不当静态路径处理
        return reply.code(400).send({ ok: false, error: 'bad path' });
      }

      let status = 200;
      let filePath = resolveStatic(pathname);
      if (!filePath) {
        // 未命中：有 404.html 就用它（真 404 语义）；无 404.html 的老式 SPA 回退 index.html
        const fourOhFour = join(distRoot, '404.html');
        if (existsSync(fourOhFour)) {
          filePath = fourOhFour;
          status = 404;
        } else {
          filePath = join(distRoot, 'index.html');
        }
      }

      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      reply.code(status);
      reply.type(MIME[ext] ?? 'application/octet-stream');
      reply.header('Cache-Control', ext === 'html' ? 'no-cache' : 'public, max-age=86400');
      return reply.send(readFileSync(filePath));
    });
  }

  // ── 会话 ──────────────────────────────────────────
  app.get('/api/sessions', async () => {
    const sessions = core.memoryManager.listSessions(50);
    return { sessions };
  });

  // ★ 8-15 会话归档(软删除:列表消失,数据保留)——仅 webui 会话
  app.post('/api/sessions/:id/archive', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!String(id).startsWith('webui:')) {
      return reply.code(403).send({ ok: false, error: 'QQ 会话不可归档' });
    }
    core.memoryManager.archiveSession(id);
    return { ok: true };
  });

  // ★ 8-15 会话彻底删除（清空数据;仅 webui 会话,QQ 会话不允许）
  app.delete('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!String(id).startsWith('webui:')) {
      return reply.code(403).send({ ok: false, error: 'QQ 会话不可删除' });
    }
    await core.memoryManager.deleteSession(id);
    return { ok: true };
  });

  app.post('/api/sessions/:id/extract', async (req) => {
    const { id } = req.params as { id: string };
    const result = await core.memoryManager.extractProfile(id);
    return result;
  });

  /**
   * 喂入外部会话事件 —— dsh 记忆回传的**写通道**。
   *
   * ★ 双进程模型（`openspec/specs/dsh-adapter/spec.md` §2）：alysia server 是记忆的
   *   **唯一写入者**；dsh 插件只回传原始事件，提取 / 5 道护栏 / 事实归一化去重 /
   *   supersede 冲突解决**全在这边**做。dsh 侧直接写库会触发 SQLITE_BUSY。
   *
   * ★ 只接受 `dsh:` 前缀的会话：写接口不该能往 QQ / WebUI 会话里注入消息。
   *   前缀同时是**来源标记**（与 `webui:` / `qq-official-1:` 同一约定）。
   *   change: connect-dsh-alysia-bridge
   */
  app.post('/api/ingest', async (req, reply) => {
    const body = req.body as { events?: unknown } | undefined;
    const events = body?.events;
    if (!Array.isArray(events) || events.length === 0) {
      return reply.code(400).send({ ok: false, error: 'events 必须是非空数组' });
    }
    if (events.length > MAX_INGEST_BATCH) {
      return reply.code(413).send({ ok: false, error: `单批最多 ${MAX_INGEST_BATCH} 条` });
    }

    let accepted = 0;
    const rejected: string[] = [];
    for (const raw of events) {
      const problem = validateIngestEvent(raw);
      if (problem) {
        rejected.push(problem);
        continue;
      }
      try {
        await core.memoryManager.ingest(normalizeIngestEvent(raw as MemoryEvent));
        accepted++;
      } catch (err: any) {
        // 单条失败不拖垮整批（重复 id / 落库异常都归这里）
        rejected.push(`${(raw as MemoryEvent).id}: ${err?.message ?? err}`);
      }
    }

    // ★ **成功也要记**：这条链路跨进程，只在失败时吭声的话，
    //   「dsh 根本没调用」和「调用了但全被拒」在日志里长得一模一样
    //   （本项目反复栽的那类「静默掩盖」）。记来源会话，便于定位是哪次会话。
    const from = (events[0] as MemoryEvent | undefined)?.session_id ?? '?';
    if (rejected.length > 0) {
      logger.warn(`[ingest] ${accepted} 条入库，${rejected.length} 条拒收（${from}）：${rejected.slice(0, 3).join(' | ')}`);
    } else {
      logger.info(`[ingest] ${accepted} 条入库（${from}）`);
    }
    return { ok: true, accepted, rejected };
  });

  // ── 委托任务（project tasks）──────────────────────────────────────
  //  ★ 2026-10-17（change: `add-project-task-delegation`）。
  //
  //  分工（与 §2.5 那条一样）：**服务端只做校验与状态，不执行**。
  //  真正跑 dsh 的是**宿主上的 runner**（alysia server 在容器里，看不到宿主上的 dsh
  //  与工作区）⇒ runner 用 `GET /api/project-tasks/next` 认领、用 `.../result` 回传。
  //
  //  ⚠️ 路径 / profile **只从登记表来**：模型与工具都不许自带目录，
  //     否则「在服务器上任意位置跑任意 profile」会变成模型能力。

  /** 项目登记的校验：未知 id 一律拒收，且**把已登记的列出来**（只说「未知」等于没说） */
  const projectOr = (id: unknown): { id: string; workspace: string; profile: string; publicUrl?: string } | null => {
    if (typeof id !== 'string' || id === '') return null;
    const p = projects[id];
    return p ? { id, workspace: p.workspace, profile: p.profile, ...(p.publicUrl ? { publicUrl: p.publicUrl } : {}) } : null;
  };
  const registered = (): string => Object.keys(projects).join(', ') || '无';

  /**
   * 从 alysia 会话 id 里取 QQ 私聊 openid。
   *
   * 真实形状（生产库实测）：`qq-official-1:private:private_<openid>`
   * ——**三段**，最后一段是 `private_<openid>`。
   *
   * ⚠️ 踩过的坑（2026-10-18）：先前写成 `/private[_:]([A-Za-z0-9_-]+)$/` 直接对整串匹配，
   *   正则**最左**命中 ⇒ 取到 `private_<openid>`（多带一段 `private_`），
   *   QQ 于是返回 `11255 请求的资源不存在`。
   *   现在改成「**先按冒号切最后一段**，再剥前缀」，不给正则留歧义。
   *
   * 取不到返回 `null`，调用方据此**跳过推送**——宁可不推，也不往错误的 openid 发。
   */
  const openidOfSession = (sessionId: string): string | null => {
    if (!sessionId.startsWith('qq')) return null;
    const last = sessionId.split(':').pop() ?? '';
    const m = /^(?:private|group)_([A-Za-z0-9_-]{6,})$/.exec(last);
    return m ? m[1] : null;
  };

  /**
   * 把委托任务的**结果送回原会话**（★ 2026-10-18，change: `return-project-task-result`）。
   *
   * 两件事分开做，缺一不可：
   *   ① **记进记忆** —— 她下一轮在「最近对话」里就能看到"我做过这件事"（不进画像/人格/摘要）
   *   ② **主动推一条** —— 用户不必先开口（QQ 主动消息有配额，故只在本轮终态推一次）
   *
   * ⚠️ 任何一步失败都**不许**影响任务本身的状态：结果已经落库了，通知是增值项。
   */
  const notifyProjectTaskResult = async (task: {
    taskId: string;
    projectId: string;
    revision: number;
    status: string;
    originSessionId: string;
    dshSessionId: string | null;
    result: unknown;
    artifacts: unknown;
  }): Promise<void> => {
    const final =
      task.result && typeof task.result === 'object' && 'final' in task.result
        ? String((task.result as { final: unknown }).final ?? '')
        : '';

    // ① 结果入记忆（原会话）
    //
    // ★ 2026-10-18（用户原话「感觉好干啊，而且没有昔涟的味道」）：
    //   这条事件是 `role: 'assistant'` —— 它以**她说过的话**的身份进她的对话史。
    //   所以**先让她自己说一遍**（人格 + 事实），再落库；模型失败才回落模板。
    const publicUrl = projects[task.projectId]?.publicUrl;
    let notice: string | null = null;
    try {
      notice = await core.memoryManager.composeProjectTaskNotice({
        projectId: task.projectId,
        revision: task.revision,
        status: task.status,
        summary: final,
        artifacts: Array.isArray(task.artifacts) ? (task.artifacts as unknown[]) : null,
        publicUrl,
      });
    } catch (err: any) {
      logger.warn(`[project-task] ${task.taskId} 通知措辞生成异常：${err?.message ?? err}`);
    }

    try {
      await core.memoryManager.recordProjectTaskResult({
        taskId: task.taskId,
        projectId: task.projectId,
        revision: task.revision,
        status: task.status,
        originSessionId: task.originSessionId,
        dshSessionId: task.dshSessionId,
        summary: final,
        artifacts: Array.isArray(task.artifacts) ? (task.artifacts as unknown[]) : null,
        // ★ 地址随回执一起给她：真机上用户问过"给我链接"，她答"我没存下地址"
        publicUrl,
        ...(notice ? { notice } : {}),
      });
    } catch (err: any) {
      logger.warn(`[project-task] ${task.taskId} 结果记回记忆失败：${err?.message ?? err}`);
    }

    // ② 主动推送（best-effort）
    if (!push?.available) return;
    const openid = openidOfSession(task.originSessionId);
    if (!openid) {
      // 不是 QQ 私聊会话（webui / 测试会话）⇒ **不猜目标**，只留痕
      logger.info(
        `[project-task] ${task.taskId} 不推送：会话 "${task.originSessionId}" 不是 QQ 私聊`,
      );
      return;
    }
    const paths = Array.isArray(task.artifacts)
      ? task.artifacts
          .map(a => (a && typeof a === 'object' && 'path' in a ? String((a as { path: unknown }).path) : ''))
          .filter(Boolean)
      : [];
    // ★ 优先用**她自己的话**（`notice`）；模型失败才用机械模板（干，但诚实）
    let text = notice?.trim() ?? '';
    if (!text) {
      const lines = [
        `委托任务结束了：${task.projectId} 第 ${task.revision + 1} 轮 → ${task.status}`,
      ];
      if (paths.length > 0) lines.push(`产物：${paths.slice(0, 5).join('、')}`);
      if (final) lines.push('', final.length > 300 ? `${final.slice(0, 300)}…` : final);
      const url = projects[task.projectId]?.publicUrl;
      if (url) lines.push('', `外网地址：${url}`);
      text = lines.join('\n');
    }

    try {
      // ★ `maxSegments: 1`：这是一条**通知**，不是她说话 —— 长文案别拆成 3 条消息
      //   （QQ 实现对 >60 字或含换行的文本会自动分段，见 `qq-official.ts` 的 8-09 设计）
      const ok = await push.sendProactive(openid, text, { maxSegments: 1 });
      logger.info(
        `[project-task] ${task.taskId} 结果推送${ok ? '成功' : '失败（通道返回 false）'} → ${openid.slice(0, 8)}…`,
      );
    } catch (err: any) {
      logger.warn(`[project-task] ${task.taskId} 结果推送异常：${err?.message ?? err}`);
    }
  };

  /** runner 可回传的终态（`queued`/`running` 不是 runner 能写的） */
  const RESULT_STATUSES = new Set(['needs_review', 'completed', 'failed', 'unknown']);

  app.post('/api/project-tasks', async (req, reply) => {
    const b = req.body as Record<string, unknown> | undefined;
    const project = projectOr(b?.projectId);
    if (!project) {
      return reply.code(400).send({
        ok: false,
        error: `未知项目 ${typeof b?.projectId === 'string' ? b.projectId : '(空)'}（已登记：${registered()}）`,
      });
    }
    const goal = typeof b?.goal === 'string' ? b.goal.trim() : '';
    if (!goal) return reply.code(400).send({ ok: false, error: 'goal 不能为空' });
    const requestKey = typeof b?.requestKey === 'string' ? b.requestKey.trim() : '';
    if (!requestKey) {
      // 没有它就没法区分「重试」与「又一次提交」——那正是会做两遍活的地方
      return reply.code(400).send({ ok: false, error: 'requestKey 不能为空（同一次调用的重试靠它去重）' });
    }

    const out = core.memoryManager.createProjectTask({
      projectId: project.id,
      requestKey,
      goal,
      acceptanceCriteria: typeof b?.acceptanceCriteria === 'string' ? b.acceptanceCriteria : '',
      originSessionId: typeof b?.originSessionId === 'string' ? b.originSessionId : '',
      origin: b?.origin === 'delegated' ? 'delegated' : 'user',
    });

    if (out.kind === 'busy') {
      // 409：不是错误，是**明确忙碌**——并返回既有任务，让调用方知道在跑什么
      return reply.code(409).send({
        ok: false,
        reason: 'busy',
        task: out.task,
        error: `项目 ${project.id} 已有在途任务 ${out.task.taskId}（状态 ${out.task.status}）`,
      });
    }
    logger.info(`[project-task] ${out.kind}：${out.task.taskId}（项目 ${project.id}）`);
    return { ok: true, reason: out.kind, task: out.task };
  });

  /**
   * runner **认领**下一个任务（原子）。
   *
   * ⚠️ 必须注册在 `/api/project-tasks/:id` **之前**：Fastify 的静态段优先，
   *   但先注册能少一个「为什么 /next 被当成 id」的排查。
   * 空闲时返回 `{ ok: true, task: null }` —— **空转是常态，不是错误**。
   */
  app.get('/api/project-tasks/next', async (req, reply) => {
    const q = req.query as { projectId?: unknown } | undefined;
    const asked = typeof q?.projectId === 'string' ? q.projectId : '';

    // ★ 2026-10-18（真机撞出来的）：`projectId` 现在**可选**。
    //   起因：runner 按项目起服务（`--project alysia-blog`）⇒ 新登记的项目**永远没人认领**，
    //   任务一路 `queued` 且**静默**（实测等了 580 秒才发现）。
    //   现在：一个 runner 服务所有项目，不指定就让服务端挑「还有活的最老的项目」。
    let project: { id: string; workspace: string; profile: string; publicUrl?: string } | null = null;
    if (asked) {
      project = projectOr(asked);
      if (!project) {
        return reply.code(400).send({
          ok: false,
          error: `未知项目 ${asked}（已登记：${registered()}）`,
        });
      }
    } else {
      const pid = core.memoryManager.nextQueuedProject();
      if (!pid) return { ok: true, task: null };
      project = projectOr(pid);
      if (!project) {
        // 有排队任务但项目已从登记表移除 ⇒ 不执行（且要留痕，不能静默）
        logger.warn(`[project-task] 有排队任务的项目 "${pid}" 未登记 —— 跳过（请清理或重新登记）`);
        return { ok: true, task: null };
      }
    }

    const task = core.memoryManager.claimNextProjectTask(project.id);
    if (!task) return { ok: true, task: null };
    logger.info(`[project-task] 被认领：${task.taskId}（revision ${task.revision}，第 ${task.attempts} 次）`);
    // 把项目配置**随认领一起下发**：runner 不需要再读一份配置（单一来源）
    return { ok: true, task, project };
  });

  app.get('/api/project-tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = core.memoryManager.getProjectTask(id);
    if (!task) return reply.code(404).send({ ok: false, error: `没有这个任务：${id}` });
    return { ok: true, task };
  });

  app.post('/api/project-tasks/:id/revision', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown> | undefined;
    const feedback = typeof b?.feedback === 'string' ? b.feedback.trim() : '';
    if (!feedback) return reply.code(400).send({ ok: false, error: 'feedback 不能为空' });

    const before = core.memoryManager.getProjectTask(id);
    if (!before) return reply.code(404).send({ ok: false, error: `没有这个任务：${id}` });

    const task = core.memoryManager.addProjectTaskRevision(id, feedback);
    if (!task) {
      // 只有「还在途」会走到这里（未知 id 已在上面挡掉）——说清楚，别让调用方猜
      return reply.code(409).send({
        ok: false,
        error: `任务 ${id} 当前状态 ${before.status} 不接受修改意见（等这一轮结束）`,
      });
    }
    logger.info(`[project-task] 续作：${id} → revision ${task.revision}（沿用工程会话 ${task.dshSessionId ?? '无'}）`);
    return { ok: true, task };
  });

  /** runner 回传结果。⚠️ 只接受仍在 `running` 的任务（迟到的回传不许覆盖） */
  app.post('/api/project-tasks/:id/result', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown> | undefined;
    const status = typeof b?.status === 'string' ? b.status : '';
    if (!RESULT_STATUSES.has(status)) {
      return reply.code(400).send({
        ok: false,
        error: `status 必须是 ${[...RESULT_STATUSES].join('/')} 之一（queued/running 由服务端自己管）`,
      });
    }
    const task = core.memoryManager.submitProjectTaskResult(id, {
      status: status as 'needs_review' | 'completed' | 'failed' | 'unknown',
      dshSessionId: typeof b?.dshSessionId === 'string' && b.dshSessionId ? b.dshSessionId : undefined,
      result: b?.result,
      artifacts: Array.isArray(b?.artifacts) ? b.artifacts : undefined,
      error: typeof b?.error === 'string' ? b.error : undefined,
    });
    if (!task) {
      return reply.code(409).send({
        ok: false,
        error: `任务 ${id} 不在 running（可能已被回收重认领，或这是一次迟到的回传）——未写入`,
      });
    }
    logger.info(`[project-task] ${id} → ${task.status}${task.dshSessionId ? `（工程会话 ${task.dshSessionId}）` : ''}`);
    // ★ 结果送回原会话（记进记忆 + 可选主动推送）。**不 await**：推送慢不该拖住 runner 的回传。
    void notifyProjectTaskResult(task);
    return { ok: true, task };
  });

  /**
   * 记忆检索 —— dsh 记忆回传的**读通道**（change: bridge-memory-read）。   *
   * ★ 与聊天管线**同一套组装**（`read()` + `assembleWithWorldbook()`）：
   *   各写各的会让她在 dsh 里和 QQ 里记起不同的东西
   *   （同 `getCompactPersonaPrompt` 的教训——「人设/记忆文本长什么样」只能有一处定义）。
   *
   * 用 POST 而非 GET：query 是用户原话，可能很长，且不该进 URL/日志历史。
   */
  app.post('/api/memory/read', async (req) => {
    const body = req.body as
      | { query?: unknown; mode?: unknown; limit?: unknown; sessionId?: unknown }
      | undefined;

    const query = typeof body?.query === 'string' ? body.query : '';
    const mode = body?.mode === 'code' ? 'code' : 'chat';
    const rawLimit = typeof body?.limit === 'number' && Number.isFinite(body.limit) ? body.limit : 5;
    const limit = Math.min(Math.max(1, Math.trunc(rawLimit)), 20);
    const sessionId = typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : undefined;

    // ★ 空 query 也照常返回：`[关于你]`/`[你的偏好]`/`[关于你的事实]` 等块
    //   **不依赖 query**（直接读 store）。dsh 侧挂载预热正是靠这一点，
    //   否则第一轮会是一片空白（provider 同步，等不到异步检索）。
    const read = await core.memoryManager.read({ query, mode, limit });
    const context = await core.memoryManager.assembleWithWorldbook(
      mode, read.worldbook_triggers, read.retrieved, sessionId,
    );

    logger.info(
      `[memory/read] query=${JSON.stringify(query.slice(0, 24))} → 召回 ${read.retrieved.length} 条 / worldbook ${read.worldbook_triggers.length} 条 / context ${context.length} 字`,
    );
    return { context, retrieved: read.retrieved };
  });

  // ── 平台 ──────────────────────────────────────────
  /**
   * ★ add-platforms-endpoint（2026-10-16）：平台接入状态。
   *
   * 契约见 `docs/Web-API-Design.md` §3.4（`AlysiaCore.getPlatformStatus()`）。
   * ⚠️ 返回的是「**哪些平台 scope 已接到事件总线**」，**不是**连接健康度 ——
   *   后者要适配器先上报心跳，见 `AlysiaCore.getPlatformStatus()` 的注释。
   */
  app.get('/api/platforms', async () => core.getPlatformStatus());

  // ── 画像 ──────────────────────────────────────────
  /**
   * 画像快照。
   *
   * ★ `?includeSuperseded=1` 时**连已作废的事实一起返回**（2026-10-16，记忆纠正首版）：
   *   纠正页需要看到"被作废的"那条 —— 否则用户没法确认「旧事实真的失效了」。
   *   默认仍过滤（画像展示只要"她现在相信的"）。
   */
  app.get('/api/profile', async (req) => {
    const includeSuperseded = String((req.query as any)?.includeSuperseded ?? '') === '1';
    return core.memoryManager.getProfileSnapshot({ includeSuperseded });
  });

  /**
   * ★ 纠正一条用户事实：旧的作废 + 写入新的（2026-10-16，记忆纠正首版）。
   *
   * 为什么要有这个端点（而不是让前端调两次）：`correctProfileFact` 是
   * **先失效旧、再写新**的一步语义，前端拆成两次会在中间态留下"两条都没有"或
   * "两条都在"的窗口，而"两条都在"正是自相矛盾的来源（见 core 里的注释）。
   */
  app.post('/api/profile/facts/correct', async (req, reply) => {
    const { oldFact, newFact } = (req.body ?? {}) as { oldFact?: unknown; newFact?: unknown };
    if (typeof oldFact !== 'string' || !oldFact.trim()) {
      return reply.code(400).send({ ok: false, error: 'oldFact 必须是非空字符串' });
    }
    if (typeof newFact !== 'string' || !newFact.trim()) {
      return reply.code(400).send({ ok: false, error: 'newFact 必须是非空字符串' });
    }
    try {
      const result = core.memoryManager.correctProfileFact(oldFact, newFact);
      logger.info(`[profile] 纠正事实 superseded=${result.superseded} added=${result.added}（${newFact.slice(0, 30)}）`);
      return { ok: true, ...result };
    } catch (err: any) {
      // 不吞：纠正失败要让调用方看见（含"新事实为空"这类调用错误）
      logger.warn(`[profile] 纠正事实失败：${err?.message ?? err}`);
      return reply.code(400).send({ ok: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * ★ 让一条事实失效（不给替换）。`stillValid: true` 则相反 —— 按分类续期。
   *
   * 这条路由此前**不存在**：`MemoryManager.confirmProfileFact` 早就实现了，
   * 但全仓没有调用方 ⇒ 能力一直不可达（`/api/profile` 只能看、不能改）。
   */
  app.post('/api/profile/facts/confirm', async (req, reply) => {
    const { fact, stillValid } = (req.body ?? {}) as { fact?: unknown; stillValid?: unknown };
    if (typeof fact !== 'string' || !fact.trim()) {
      return reply.code(400).send({ ok: false, error: 'fact 必须是非空字符串' });
    }
    if (typeof stillValid !== 'boolean') {
      return reply.code(400).send({ ok: false, error: 'stillValid 必须是布尔值' });
    }
    const ok = core.memoryManager.confirmProfileFact(fact, stillValid);
    logger.info(`[profile] confirm fact stillValid=${stillValid} ok=${ok}（${fact.slice(0, 30)}）`);
    // ok=false = 没找到这条事实；**这与"操作失败"不同**，如实返回让前端能区分
    return { ok, found: ok };
  });

  // ── 人格 ──────────────────────────────────────────
  app.get('/api/persona', async () => core.memoryManager.getPersonaSnapshot());

  /**
   * 人设文本（紧凑形式）—— dsh 侧动态人设的读通道。
   *
   * ★ 与聊天管线**同一份文本**（`MemoryManager.getCompactPersonaPrompt()`）：
   *   各写各的会让她在 dsh 里和 QQ 里变成两个人。
   *   change: connect-dsh-alysia-bridge
   */
  app.get('/api/persona/prompt', async () => {
    const prompt = core.memoryManager.getCompactPersonaPrompt();
    // ★ 记一行：这条链路是跨进程的（dsh 插件 → 这里），出问题时
    //   「没人调用」和「调用了但返回不对」必须能分开——否则只能干瞪眼。
    logger.info(`[persona/prompt] 提供人设 ${prompt.length} 字`);
    return { prompt };
  });

  app.post('/api/persona/adjust', async (req) => {
    const { param, delta, reason } = req.body as { param: string; delta: number; reason?: string };
    const result = core.memoryManager.adjustPersona(param, delta, reason ?? 'WebUI 手动调整');
    return result;
  });

  // ── Token 统计 ─────────────────────────────────────
  app.get('/api/stats', async () => {
    // ★ 走 MemoryManager 公开接口，不直接读 pipeline 内部状态
    const result = core.memoryManager.getTokenStats() as {
      global: { input: number; output: number; tokens: number };
      perSession: Record<string, { recordCount: number; totalInput: number; totalOutput: number; totalTokens: number }>;
    };
    // 补充关联的 session 元信息（messageCount / lastActive）
    const sessions = core.memoryManager.listSessions(200);
    const sessionMeta = new Map(sessions.map(s => [s.sessionId, { messageCount: s.messageCount, lastActive: s.lastActive }]));
    const perSession: Record<string, unknown> = {};
    for (const [id, stat] of Object.entries(result.perSession)) {
      perSession[id] = { ...stat, ...(sessionMeta.get(id) ?? {}) };
    }
    return { global: result.global, perSession };
  });

  // ── 角色系统 ───────────────────────────────────────
  app.get('/api/roles', async () => {
    const roles = core.memoryManager.listRoles();
    const active = core.memoryManager.getActiveRoleId();
    return { roles, activeRole: active };
  });

  app.post('/api/roles/switch', async (req) => {
    const { roleId } = req.body as { roleId: string };
    const result = core.memoryManager.switchRole(roleId);
    return { activeRole: core.memoryManager.getActiveRoleId(), ...result };
  });

  app.get('/api/roles/active', async () => core.memoryManager.getActiveRole());

  app.post('/api/roles/import', async (req) => {
    const result = core.memoryManager.importRole(req.body as any);
    return result;
  });

  app.get('/api/roles/:id/export', async (req) => {
    const { id } = req.params as { id: string };
    const pkg = core.memoryManager.exportRole(id);
    if (!pkg) return { error: 'Role not found' };
    return pkg;
  });

  // ── 知识库 ─────────────────────────────────────────
  app.get('/api/knowledge', async () => ({ docs: core.memoryManager.listKnowledgeDocs() }));

  app.post('/api/knowledge/import', async (req) => {
    const result = await core.memoryManager.importKnowledge(req.body as any);
    return result;
  });

  app.delete('/api/knowledge/:id', async (req) => {
    await core.memoryManager.deleteKnowledgeDoc((req.params as any).id);
    return { ok: true };
  });

  // ── 表情包 ─────────────────────────────────────────
  app.get('/api/stickers', async () => {
    const all = core.memoryManager.listStickers();
    // 过滤文件缺失的条目(角色包条目可能比实际文件多——缺失的图无法展示,
    // 只显示真实存在的;日志提示便于补文件)
    const stickers = all.filter(s => resolveSticker(s.path) !== null);
    const missing = all.length - stickers.length;
    if (missing > 0) {
      logger.warn(`[Stickers] ${missing}/${all.length} 个条目文件缺失(已从列表过滤): ` +
        all.filter(s => resolveSticker(s.path) === null).map(s => s.name).join(', '));
    }
    return { stickers };
  });

  // ★ 8-15 表情包文件（聊天视图 [表情包:名字] 渲染用）
  //   路径兼容:db 里存 /data/stickers/x.png(容器绝对路径)——Windows 桌面端需
  //   回退到 server data 目录解析
  const stickerDataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/stickers');
  const resolveSticker = (content: string): string | null => {
    const candidates = [
      content,
      content.replace(/^\/+/, ''),
      resolve(stickerDataDir, basename(content)),
    ];
    for (const c of candidates) {
      try { if (existsSync(c)) return c; } catch { /* 非法路径跳过 */ }
    }
    return null;
  };
  app.get('/api/stickers/file/:name', async (req, reply) => {
    const s = core.memoryManager.findSticker((req.params as any).name);
    if (!s?.content) return reply.code(404).send({ ok: false, error: 'sticker not found' });
    const resolved = resolveSticker(s.content);
    if (!resolved) return reply.code(404).send({ ok: false, error: 'sticker file missing' });
    try {
      const data = readFileSync(resolved);
      const ext = resolved.split('.').pop()?.toLowerCase() ?? '';
      const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
      reply.header('Content-Type', mime[ext] ?? 'application/octet-stream');
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(data);
    } catch {
      return reply.code(404).send({ ok: false, error: 'sticker file missing' });
    }
  });

  // ── 隐私模式 ───────────────────────────────────────
  app.post('/api/privacy', async (req) => {
    const { mode } = req.body as { mode: 'off' | 'readonly' | 'full' };
    core.memoryManager.setPrivacyMode(mode);
    return { privacyMode: core.memoryManager.getPrivacyMode() };
  });

  // ── AI 主动生活 ────────────────────────────────────
  app.get('/api/life', async () => {
    const snapshot = core.memoryManager.getLifeSnapshot();
    const events = core.memoryManager.listLifeEvents(7);
    return { snapshot, events };
  });

  // ★ 9-25 add-life-readonly-endpoints：两个「core 有方法、无出口」的只读补口
  //   窗口与 /api/life 一致（7 天），避免"摘要 30 天 / 事件 7 天"的错位
  /** 近 7 天每日生活摘要（旧 → 新） */
  app.get('/api/life/summaries', async () => ({
    summaries: core.memoryManager.listLifeSummaries(7),
  }));

  /** 配角在场状态（含 off-scene；由 LifeService 巡检维护，只读） */
  app.get('/api/life/companions', async () => ({
    companions: core.memoryManager.listScenePresence(),
  }));

  // ── ★ 8-14 内容自进化（content-self-evolution）：硬审计面 + 用户事后删除兜底 ──
  app.get('/api/worldbook', async () => ({ entries: core.memoryManager.listWorldbookEntries() }));

  app.delete('/api/worldbook/:id', async (req) => {
    const ok = core.memoryManager.deleteWorldbookEntry((req.params as any).id);
    return { ok };
  });

  app.get('/api/life/templates', async () => ({ templates: core.memoryManager.listLifeTemplates() }));

  // ★ 8-15 手动新增生活模板(走 addLifeTemplate 全流程:机械预检 + LLM 校验,weight 固定 2)
  app.post('/api/life/templates', async (req, reply) => {
    const { activity, type } = (req.body ?? {}) as { activity?: string; type?: string };
    if (!activity?.trim()) return reply.code(400).send({ ok: false, error: 'activity 为空' });
    const result = await core.memoryManager.addLifeTemplate({
      activity: activity.trim(),
      type: type === 'chat' ? 'chat' : 'internal',
    });
    return result;
  });

  app.delete('/api/life/templates/:id', async (req) => {
    const ok = core.memoryManager.deleteLifeTemplate((req.params as any).id);
    return { ok };
  });

  return app;
}
