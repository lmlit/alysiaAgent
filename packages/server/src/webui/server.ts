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
import { MAX_INGEST_BATCH, validateIngestEvent, normalizeIngestEvent, UNKNOWN_SESSION_ID } from '../ingest.js';
import type { MemoryEvent } from '@alysia/core/memory';
import { computeTaskWindow } from '@alysia/core/memory';
import { PHASE_PROMPTS, type LoopPhase } from '@alysia/core/memory';
// ★ 2026-10-19（change: `wake-her-on-task-result`）：结果事件体（纯函数，形状即契约）
import { buildSubagentResultPayload } from '@alysia/core/memory';
import { pickPageUrl } from './receipt-url.js';
import { hostPagesCache, parseHostPagesInput } from '../host-pages.js';
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, writeFileSync as writeFileSyncForVision } from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

/**
 * ★ 2026-10-19（change: `wake-her-on-task-result`）：runner 令牌的**端点白名单**。
 *
 * 判定原则：**只放开它真的在用的那几条**，不是"除了这些都能用"。
 * 每一条都对应一个已知调用方，加一条要在这里写清是谁在调：
 *
 * | 端点 | 谁在调 |
 * |---|---|
 * | `GET /api/persona/prompt` | dsh 适配器（动态人设） |
 * | `POST /api/ingest` | dsh 适配器的记忆回传 |
 * | `POST /api/memory/read` | dsh 适配器的 `recall_memory` |
 * | `POST /api/sessions/:id/extract` | dsh 会话结束时的结算（仅命令行匹配，不含通配） |
 * | `/api/project-tasks/**` | 宿主 runner（认领 / 推进 / 回传 / 查窗口） |
 * | `POST /api/host/pages` | 宿主 runner 推页面清单 |
 * | `POST /api/vision/describe` | 宿主 runner / dsh 看图 |
 * | `GET /api/health` | 已在钩子里豁免 |
 *
 * ⚠️ 特意**不**放开：角色导入/导出、知识库删除、隐私开关、人格调整、`/api/life` 写入类。
 */
export function isRunnerAllowed(method: string, path: string): boolean {
  if (method === 'GET' && path === '/api/persona/prompt') return true;
  if (method === 'POST' && path === '/api/ingest') return true;
  if (method === 'POST' && path === '/api/memory/read') return true;
  if (method === 'POST' && path === '/api/host/pages') return true;
  if (method === 'POST' && path === '/api/vision/describe') return true;
  // /api/sessions/<id>/extract —— 只认这一条形状（别用宽松前缀，那会顺带放开别的会话端点）
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/extract$/.test(path)) return true;
  if (path.startsWith('/api/project-tasks')) return true;
  return false;
}

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
   * ★ 2026-10-18（change: `gate-project-tasks-to-offpeak`）：执行窗口。
   * 高峰时段（工作日 9-12 / 14-18，北京时间）**只排队不认领**。
   */
  projectTasks?: {
    holidays?: string[];
    peakWindows?: Array<[number, number]>;
    /** 【排障用】把窗口判定固定在这个时刻（ISO）；生产别配 */
    nowOverride?: string;
    /**
     * ★ 2026-10-18（change: `make-author-iterate`）：状态机里走到 `publish` 阶段时
     * 是否允许她真的发布。默认 `false`（"上线"这一步留给人）。
     */
    allowPublish?: boolean;
  };
  /**
   * 时钟（**测试/排障用**）：可在固定时刻验证执行窗口，不必等到周一上午。
   * 生产不传 ⇒ 用真实时间。
   */
  clock?: () => Date;
  /**
   * 主动推送通道（`al:push`）。★ 2026-10-18（change: `return-project-task-result`）：
   * 委托任务结束后要**回到原会话告诉她**。缺省 = 无通道（桌面端/无 QQ 时），只记日志不推。
   */
  push?: {
    available: boolean;
    sendProactive(openid: string, message: string, opts?: { maxSegments?: number }): Promise<boolean>;
  };
  /**
   * 视觉桥（`al:vision`，GLM-4V-Flash）。★ 2026-10-18（change: `give-author-eyes`）：
   * 委托方是**文本模型**，看不见自己做的页面 —— 给它一条"把图变成话"的通道。
   * 缺省 = 没配视觉模型，此时 `/api/vision/describe` 返回 501（**明确不可用**，不是假装成功）。
   */
  vision?: { describe(imagePath: string, prompt?: string): Promise<string | null> };
  /**
   * ★ 2026-10-19（change: `wake-her-on-task-result`）：**宿主 runner 专用令牌**。
   *
   * 为什么要把令牌拆开：runner 的子进程是 `dsh`（非 root，但**继承 runner 的环境**）。
   * 它只需要「回传记忆 / 领任务 / 推页面清单 / 看图」这几条；拿全权管理 token 等于
   * 一个后台执行体握着你整个管理面。
   *
   * 配了就生效：这个 token 只能调白名单端点（见 `isRunnerAllowed`），其余一律 403。
   * 不配 ⇒ 行为与以前一致（只有 `webuiToken` 一条路）。
   */
  runnerToken?: string;
  /**
   * ★ 2026-10-19（change: `wake-her-on-task-result`）：**异步唤醒开关**。
   *
   * `true`（默认）：终态结果只入队，由 `al:subagent-wake` 领走、跑一轮主 Agent 再说话；
   * `false`：**回退到旧行为** —— 落库 + 一次性通知 + 直接推送（不唤起任何一轮）。
   * 用途：出问题时一个开关退回，普通聊天完全不受影响。
   */
  subagentWake?: boolean;
  /**
   * ★ 2026-10-19：自动返工上限（按任务血缘累计）。写进事件体给她看「还能不能改」。
   * 真正的拦截在 `al:subagent-wake`（它决定要不要让她继续）——这里只负责把余额告诉她。
   */
  maxAutoRework?: number;
}

export function createWebuiApp(core: AlysiaCore, opts: WebuiAuthOptions = {}) {
  const { webuiToken = '', requireAuth = false, staticDist } = opts;
  /**
   * 委托项目登记表（★ 2026-10-17，change: `add-project-task-delegation`）。
   * ⚠️ 空表 = 该能力未配置：相关端点会**响亮拒绝**并说明「已登记：无」，
   *    而不是假装受理（否则提交方以为任务排上了，其实没人会跑）。
   */
  const projects = opts.projects ?? {};
  /** 执行窗口（高峰只排队；缺省=空配置 ⇒ 按默认高峰窗口） */
  const taskWindowConfig = opts.projectTasks;
  /** 只在测试/排障时注入；生产走真实时间 */
  const nowOverride = opts.clock?.();

  /** 当前执行窗口（认领闸门与 `/api/project-tasks/window` 共用，保证两处判断一致） */
  const currentWindow = () => {
    const fixed = nowOverride ?? (taskWindowConfig?.nowOverride ? new Date(taskWindowConfig.nowOverride) : undefined);
    return computeTaskWindow({ ...(taskWindowConfig ?? {}), ...(fixed ? { now: fixed } : {}) });
  };
  /** 主动推送通道（可能不存在 —— 桌面端/无 QQ 时是空实现） */
  const push = opts.push;
  /** 视觉桥（可能不存在 —— 没配视觉模型时不可用） */
  const vision = opts.vision;
  const app = Fastify({ logger: false });

  // ★ 8-29 cr-p0-webui-auth：auth 钩子（chat 路由 registerChatRoutes 同受保护）
  // ★ 9-24 console-local-serve 修复：原实现拦下**所有**请求，与上方声明的意图
  //   （"所有 /api/* 校验"）不符 —— 后果是浏览器导航到 `/` 拿 401，前端页面根本加载不出来
  //   （浏览器导航带不上 Authorization 头）。旧前端没暴露此问题是因为静态文件从不由 Fastify 出：
  //   本地走 vite dev，Docker 镜像里没打包 dist。
  //   现改为只守 /api/*：静态资源公开、数据仍在鉴权后 —— 标准 SPA + API 鉴权模型。
  if (requireAuth) {
    // ★ 2026-10-19（change: `wake-her-on-task-result`）：**双令牌**。
    //   管理 token = 全权；runner token = 只够它干活的那几条。见 `isRunnerAllowed`。
    const runnerToken = (opts.runnerToken ?? '').trim();
    app.addHook('onRequest', async (req: any, reply: any) => {
      const path = String(req.url ?? '').split('?')[0];
      if (!path.startsWith('/api/')) return; // 静态资源/页面不鉴权
      if (path === '/api/health') return;    // 容器 healthcheck 豁免
      const auth = String(req.headers.authorization ?? '');
      // runner 令牌：**先判白名单**，不在白名单上一律 403（不是 401：它是被识别出来的调用方）
      if (runnerToken && auth === `Bearer ${runnerToken}`) {
        if (isRunnerAllowed(String(req.method ?? '').toUpperCase(), path)) return;
        logger.warn(`[auth] runner 令牌越权：${req.method} ${path} —— 已拒绝`);
        return reply.code(403).send({
          ok: false,
          error: 'runner 令牌只能调白名单端点（记忆回传/任务/页面清单/看图）—— 这不是你的权限问题，是设计',
        });
      }
      if (!webuiToken || auth !== `Bearer ${webuiToken}`) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });
  }

  // ★ 8-15 WebUI 聊天端点（webui-chat-endpoints）：prompt/stream/messages/pending
  registerChatRoutes(app, core);

  // ── 系统 ──────────────────────────────────────────
  app.get('/api/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  // ─────────────────────────────────────────────────────────────
  // ★ 2026-10-18（change: `give-author-eyes`）：看图说话
  //
  // 为什么需要：委托方是**文本模型** —— 她能 grep 出"零外链"、能 curl 出 200，
  // 但**看不见页面长什么样**。布局塌了、字被裁了，她的自检照样全绿。
  // 服务端本来就有 VisionBridge（GLM-4V-Flash），把它开成一条通道给她即可。
  //
  // 传输用 **base64 + 容器内临时文件**，不用 URL：服务端在容器里，
  // 拿不到宿主路径，也不该依赖"容器能不能访问宿主的 3389"。
  // ─────────────────────────────────────────────────────────────
  app.post(
    '/api/vision/describe',
    { bodyLimit: 12 * 1024 * 1024 },
    async (req, reply) => {
      if (!vision) {
        return reply.code(501).send({
          ok: false,
          error: '没有配置视觉模型（al:vision 不可用）—— 这条能力现在不存在，不是你的错',
        });
      }
      const body = req.body as { imageBase64?: unknown; prompt?: unknown } | undefined;
      const b64 = typeof body?.imageBase64 === 'string' ? body.imageBase64 : '';
      if (!b64.trim()) return reply.code(400).send({ ok: false, error: '缺 imageBase64' });

      // 调用方常常直接塞 dataURL —— 剥掉前缀再解码
      const raw = b64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s+/g, '');
      const buf = Buffer.from(raw, 'base64');
      if (buf.length === 0) return reply.code(400).send({ ok: false, error: '图片解码后为空' });
      if (buf.length > 8 * 1024 * 1024) {
        return reply.code(413).send({ ok: false, error: `图片太大（${buf.length} 字节 > 8MB）` });
      }

      const prompt =
        typeof body?.prompt === 'string' && body.prompt.trim()
          ? body.prompt.trim()
          : '这是一个网页截图。请用 3-6 句话描述：整体布局、配色、主要区块；' +
            '并指出有没有明显的排版问题（文字溢出/重叠/大面积空白/图片缺失/对比度太低看不清）。' +
            '只说你真的看见的，不要猜。';

      const tmp = join(tmpdir(), `alysia-vision-${randomUUID()}.png`);
      try {
        writeFileSyncForVision(tmp, buf);
        const text = await vision.describe(tmp, prompt);
        if (!text || !text.trim()) {
          return reply.code(502).send({ ok: false, error: '视觉模型没有返回描述（模型/配额问题）' });
        }
        logger.info(`[vision] describe ok：${buf.length} bytes → ${text.length} 字`);
        return { ok: true, text, bytes: buf.length };
      } catch (err: any) {
        logger.warn(`[vision] describe 失败：${err?.message ?? err}`);
        return reply.code(500).send({ ok: false, error: `视觉描述失败：${err?.message ?? err}` });
      } finally {
        try { unlinkSync(tmp); } catch { /* 临时文件删不掉不致命 */ }
      }
    },
  );


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

  /**
   * ★ 2026-10-20（change: guard-session-extract-endpoint；KI-18）：**入口校验**。
   *
   * 此前这条路由对 `id` 一个字都不看，而同文件邻居都有边界（`/api/ingest` 只收 `dsh:`、
   * archive/delete 只收 `webui:`）—— 于是任何过了鉴权的调用方都能对**任意会话**触发结算
   * （摘要 + 画像提取 + 人格确认，全是真 LLM 调用，且摘要槽正是已爆三次预算事故的那个）。
   *
   * 两道闸，**刻意只收到"不能是垃圾"为止**：
   *   ① 形状：非空、不含 `/`、不是 `dsh:unknown`（复用 ingest 的常量，不新造字符串）
   *   ② 存在性：零事件 ⇒ 404 响亮失败
   *
   * ⚠️ **不加**「只允许 `dsh:` 前缀」：extract 同时服务 WebUI 会话的手动提取，
   *   按来源一刀切会砍掉合法用法 —— 这也正是当初没加校验的合理部分。
   */
  app.post('/api/sessions/:id/extract', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sid = String(id ?? '').trim();
    if (!sid || sid.includes('/')) {
      return reply.code(400).send({ ok: false, error: '会话 id 不合法（空或含 /）' });
    }
    if (sid === UNKNOWN_SESSION_ID) {
      return reply.code(400).send({
        ok: false,
        error: '拒绝对 dsh:unknown 结算：它不是真实会话 id（适配器拿不到 session.id 时的退化桶），'
          + '结算它会把多个真实会话的内容混进同一份摘要与画像',
      });
    }
    // 存在性：判据是"有没有事件"，不是"会不会产出新事实"（后者是结算结果，不能当入口判据）
    if (core.memoryManager.countSessionEvents(sid) === 0) {
      return reply.code(404).send({
        ok: false,
        error: `会话不存在或没有任何事件：${sid} —— 结算不会凭空产出东西，这不等于"提取成功"`,
      });
    }
    return core.memoryManager.extractProfile(sid);
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
  /**
   * ★ 2026-10-19（change: `give-her-a-publish-tool`）：**这次任务能不能上线**。
   *
   * 在此之前是全局 `allowPublish` 一把闸刀，造成死锁：`public/` 只在 publish 阶段可写，
   * 而 `allowPublish: false` ⇒ 她永远走不到 publish 阶段 ⇒ 用户委托"把这个发布出去"
   * 她一做就是违规、轮末还被没收（真机上把整站搬走过一次）。
   *
   * 正确口径：**"她能不能自己决定上线"与"用户让她上线"是两件事。**
   * - `origin === 'self'`（她自己发起的小项目）⇒ 由配置 `allowPublish` 决定（默认拒）；
   * - `user` / `delegated`（用户要的）⇒ **允许**。
   *
   * 消费者三处：认领响应（runner 透传成 `ALYSIA_ALLOW_PUBLISH` 给 `publish_page` 工具）、
   * 阶段推进（能不能进 publish 阶段）、回执措辞。
   */
  const allowPublishForTask = (t: { origin?: string } | null | undefined): boolean =>
    t?.origin === 'self' ? taskWindowConfig?.allowPublish === true : true;

  /**
   * ★ 2026-10-19（change: `wake-her-on-task-result`）：**唤醒开关**（缺省开）。
   * 关掉 ⇒ 回退到旧路径（落库 + 一次性通知 + 直接推送），不唤起任何一轮。
   */
  const wakeEnabled = opts.subagentWake !== false;

  /**
   * 从任务的产物里挑出「本轮那个页面」的地址（契约 38 / 38c）。
   * 服务端只做**合法前缀校验**，不自己拼（runner 才知道工作区里谁动过）。
   */
  const receiptUrlOf = (projectId: string, artifacts: unknown): string | undefined =>
    pickPageUrl(projects[projectId]?.publicUrl, artifacts);

  /**
   * 组装一条「结果事件」的持久化体（★ 2026-10-19，change: `wake-her-on-task-result`）。
   *
   * 入队与任务终态**同一事务**（`submitResult` 里做），所以这里只负责把
   * 「她做决定需要的信息」一次备齐：原目标 / 当前要求 / 产物 / 证据 / 返工余额。
   * ⚠️ 证据（新鲜度）由 `computeEvidence` **按 mtime 算**，不采信执行侧自述。
   */
  const buildResultEvent = (
    task: {
      taskId: string;
      projectId: string;
      revision: number;
      originSessionId: string;
      originalGoal: string;
      goal: string;
      acceptanceCriteria: string;
    },
    status: string,
    body: Record<string, unknown>,
  ) => {
    const result = body?.result && typeof body.result === 'object' ? (body.result as Record<string, unknown>) : {};
    const artifacts = Array.isArray(body?.artifacts) ? (body.artifacts as unknown[]) : null;
    const summary = typeof result.final === 'string' ? result.final : '';
    const roundStartedAt = typeof result.roundStartedAt === 'number' ? result.roundStartedAt : undefined;
    const pageVerified = typeof result.pageVerified === 'boolean' ? result.pageVerified : undefined;
    const pageUrl = receiptUrlOf(task.projectId, artifacts);

    const payload = buildSubagentResultPayload({
      taskId: task.taskId,
      projectId: task.projectId,
      revision: task.revision,
      status,
      conversationId: task.originSessionId,
      originalGoal: task.originalGoal,
      currentRequirement: task.goal,
      acceptanceCriteria: task.acceptanceCriteria,
      dshSessionId: typeof body?.dshSessionId === 'string' ? body.dshSessionId : null,
      summary,
      artifacts,
      evidence: { roundStartedAt, pageVerified, ...(pageUrl ? { pageUrl } : {}) },
      autoRework: { used: task.revision, max: opts.maxAutoRework ?? 2 },
    });
    return { eventId: payload.eventId, taskId: task.taskId, projectId: task.projectId, revision: task.revision, payload };
  };

  const openidOfSession = (sessionId: string): string | null => {
    const parts = sessionId.split(':');
    if (parts.length < 3) return null;
    const platform = parts[0] ?? '';
    const type = parts[1] ?? '';
    if (!platform.startsWith('qq')) return null;
    /**
     * ★ 2026-10-19（change: `wake-her-on-task-result`）：**群会话不推**。
     *
     * 旧实现的正则同时接受 `private_` 与 `group_`，然后把结果交给
     * `sendProactive` —— 而那个方法走的是 `POST /v2/users/{openid}`（私聊端点）。
     * 于是群会话的 openid 会被当私聊发出去：轻则失败，重则发错人。
     */
    if (type !== 'private') return null;
    const last = parts[parts.length - 1] ?? '';
    const m = /^private_([A-Za-z0-9_-]{6,})$/.exec(last);
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
    /**
     * ★ 2026-10-18（补）：她自己写的「哪里像我」（runner 从 NOTES.md 读出来随结果回传）。
     * 这是她最有辨识度的文字 —— 以前只被阶段闸门读，人看不到。
     */
    const selfStatement =
      task.result && typeof task.result === 'object' && 'selfStatement' in task.result
        ? String((task.result as { selfStatement: unknown }).selfStatement ?? '').trim()
        : '';

    // ① 结果入记忆（原会话）
    //
    // ★ 2026-10-18（用户原话「感觉好干啊，而且没有昔涟的味道」）：
    //   这条事件是 `role: 'assistant'` —— 它以**她说过的话**的身份进她的对话史。
    //   所以**先让她自己说一遍**（人格 + 事实），再落库；模型失败才回落模板。
    const publicUrl = projects[task.projectId]?.publicUrl;
    /**
     * ★ 2026-10-18（change: `fix-receipt-link-to-produced-page`）：带**本轮产物页**的地址，
     *   不是项目门牌（契约 38）。真机上用户点门牌看到的是她自己半夜做的「月光花园」。
     *   runner 上报 `artifacts[{path,published,url}]`（它能读工作区，容器不能）。
     */
    const receiptUrl = pickPageUrl(publicUrl, task.artifacts);
    let notice: string | null = null;
    try {
      notice = await core.memoryManager.composeProjectTaskNotice({
        projectId: task.projectId,
        revision: task.revision,
        status: task.status,
        summary: final,
        artifacts: Array.isArray(task.artifacts) ? (task.artifacts as unknown[]) : null,
        publicUrl: receiptUrl,
        // ★ 2026-10-18（补）：通知也要有"她跟这个人怎么说话"的上下文，
        //   否则它是**通用人格**（聊天回复有记忆/最近对话，通知原先没有）。
        originSessionId: task.originSessionId,
        ...(selfStatement ? { selfStatement } : {}),
      });
    } catch (err: any) {
      logger.warn(`[project-task] ${task.taskId} 通知措辞生成异常：${err?.message ?? err}`);
    }
    // ★ 2026-10-18（补）：把**生成的措辞**记进日志（不等推送）。
    //   理由：部署后要能无副作用地确认"通知像不像她"——不该为了验收真给用户发一条 QQ。
    if (notice) {
      logger.info(
        `[project-task] ${task.taskId} 通知草稿（${notice.length} 字）：${notice.replace(/\n/g, ' ⏎ ')}`,
      );
    }
    if (selfStatement) {
      logger.info(
        `[project-task] ${task.taskId} 她自己的话（${selfStatement.length} 字）：${selfStatement.slice(0, 160)}`,
      );
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
        // ★ 2026-10-18（fix-receipt-link-to-produced-page）：这里的地址已经是**本轮产物页**
        publicUrl: receiptUrl,
        // ★ 2026-10-18（attribute-engine-receipts）：**不再**把她的措辞塞进记忆回执。
        //   记忆里那条是「我这次的执行记录」（role=engine），借她的聊天口吻等于伪造归属。
        //   她的措辞只用于下面那一步 **QQ 推送**（那里真的是她在说话）。
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
      // ★ 机械回落：措辞也用第一人称（change: `unify-her-voice-across-engineering`）——
      //   那一轮是她自己做的，"委托任务结束了"会把她自己说成第三方。
      const lines = [
        `我这一轮跑完了：${task.projectId} 第 ${task.revision + 1} 轮 → ${task.status}`,
      ];
      if (paths.length > 0) lines.push(`做出来的文件：${paths.slice(0, 5).join('、')}`);
      if (final) lines.push('', final.length > 300 ? `${final.slice(0, 300)}…` : final);
      const url = receiptUrl;
      if (url) lines.push('', `外网地址：${url}`);
      text = lines.join('\n');
    }
    // ★ 2026-10-18（采纳）：把她自己写的「哪里像我」附在通知末尾 ——
    //   这一段最能看出她的判断，而原先只有阶段闸门读它，人看不到。
    //   附**原文**（不走模型改写），保证她的话原样到你手上。
    if (selfStatement) {
      const stmt = selfStatement.length > 260 ? `${selfStatement.slice(0, 260)}…` : selfStatement;
      text = `${text}\n\n她自己的话：${stmt}`;
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
      // ★ 2026-10-19（`let-tasks-declare-their-kind`）：'action' = 做一件事（单轮），
      //   'build' = 做一件新东西（六阶段）。缺省 build，老调用方行为不变。
      kind: b?.kind === 'action' ? 'action' : 'build',
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
  /**
   * 当前执行窗口（**只读**）。
   *
   * ★ 2026-10-18（change: `gate-project-tasks-to-offpeak`）：加了闸门之后，
   *   第一个问题一定是"我的任务为什么不动"。这个端点就是那个答案 ——
   *   它把判定依据（原因 / 现在 / 什么时候解禁 / 用的窗口配置）原样吐出来。
   */
  /**
   * ★ 2026-10-19（change: let-her-query-what-she-made）：宿主 runner 推上来的**页面清单**。
   *
   * 为什么要有这条上传：她在聊天里要回答"那页的网址呢"，而清单是宿主上的文件
   * （`/srv/alysia-preview/pages.json`，基站生成器每 10s 重建）—— 容器看不到宿主目录。
   * 由 runner 每轮推一份，这里只存最新（只读投影，真相仍在宿主的 pages.json / public/）。
   *
   * ⚠️ 形状不对就 **400**，别静默吞：上一份留着，工具里会如实说"是几分钟前的"。
   */
  app.post('/api/host/pages', async (req, reply) => {
    const index = parseHostPagesInput(req.body);
    if (!index) {
      return reply.code(400).send({ ok: false, error: '形状不对：需要 {generatedAt, pages:[{projectId,file,title,url,published,updatedAt}]}' });
    }
    hostPagesCache.set(index);
    logger.info(
      `[host-pages] 收到页面清单：${index.pages.length} 页（生成于 ${index.generatedAt || '(未给)'}）`,
    );
    return { ok: true, count: index.pages.length };
  });

  /** 只读自查：她（或我们）能确认服务端手里那份清单有多新 */
  app.get('/api/host/pages', async () => {
    const idx = hostPagesCache.get();
    return idx ? { ok: true, ...idx } : { ok: true, pages: [], note: '还没收到过（runner 没推 / hub 没跑）' };
  });

  app.get('/api/project-tasks/window', async () => {
    const w = currentWindow();
    return {
      ok: true,
      window: w,
      config: {
        peakWindows: taskWindowConfig?.peakWindows ?? null,
        holidays: taskWindowConfig?.holidays ?? null,
        nowOverride: taskWindowConfig?.nowOverride ?? null,
      },
    };
  });

  app.get('/api/project-tasks/next', async (req, reply) => {
    const q = req.query as { projectId?: unknown } | undefined;
    const asked = typeof q?.projectId === 'string' ? q.projectId : '';

    // ★ 2026-10-18（change: `gate-project-tasks-to-offpeak`）：
    //   **高峰时段不认领**。任务留在 queued，等窗口过去再跑 —— 钱按执行时间算，
    //   排队本身不花；而拒收任务等于让用户和模型都去记时段。
    const win = currentWindow();
    if (!win.offPeak) {
      return {
        ok: true,
        task: null,
        paused: { reason: win.reason, until: win.until, message: win.message },
      };
    }

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
    // ★ 2026-10-18（make-author-iterate）：连同**这一轮该干什么**一起下发 ——
    //   阶段指令只在这里定义（`PHASE_PROMPTS`），runner 不要在本地再抄一份。
    // ★ 2026-10-19（`let-tasks-declare-their-kind`）：`action`（做一件事）**不下发阶段指令** ——
    //   否则她会被"这一轮只做这一件事：写「## 意图」…"带偏（真机就是这样：让她发布，她跑去写意图）。
    const nextPrompt =
      task.kind === 'action' || !task.phase || task.phase === 'done'
        ? ''
        : PHASE_PROMPTS[task.phase as Exclude<LoopPhase, 'done'>] ?? '';
    /**
     * ★ 2026-10-19（change: `give-her-a-publish-tool`）：**按任务来源**判"这次能不能上线"。
     *
     * 起因是一个死锁：`public/` 只在 publish 阶段可写，而 `allowPublish: false`
     * ⇒ 她**永远走不到** publish 阶段 ⇒ 用户委托她"把这个发布出去"，她一做就是违规、
     * 轮末还被没收（真机上把整站搬走过一次）。
     *
     * 正确口径：**"她能不能自己决定上线"和"用户让她上线"是两件事。**
     * - `origin === 'self'`（她自己发起的）⇒ 由配置 `allowPublish` 决定（默认拒）；
     * - 用户委托（`user` / `delegated`）⇒ **允许**（他要的就是这个）。
     *
     * 消费者三处：runner 透传成 `ALYSIA_ALLOW_PUBLISH`（给 `publish_page` 工具）、
     * 阶段推进（能不能进 publish 阶段）、回执措辞。
     */
    return { ok: true, task, project, nextPrompt, allowPublish: allowPublishForTask(task) };
  });

  /**
   * 推进「做一件东西」的状态机（★ 2026-10-18，change: `make-author-iterate`）。
   *
   * runner 每跑完一个阶段，把**从文件系统读到的事实**发上来；服务端据此决定：
   * 进下一阶段 / 原地重试（附原因）/ 收工。
   * ⚠️ 事实由 runner 算（它能读工作区），但**判据在服务端**（纯函数 `advanceLoop`）——
   *   执行端不能自己宣布"我改好了"。
   */
  app.post('/api/project-tasks/:id/advance', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { facts?: unknown } | undefined;
    const facts = b?.facts;
    if (!facts || typeof facts !== 'object') {
      return reply.code(400).send({ ok: false, error: '缺 facts（由 runner 从工作区读出来）' });
    }
    const f = facts as {
      notes?: unknown; drafts?: unknown; shots?: unknown;
      builtPages?: unknown; published?: unknown;
      /** ★ 2026-10-18（change: `scope-loop-to-this-round`）：判"这一轮的笔记动了没有" */
      notesMtime?: unknown; sinceMs?: unknown;
    };
    const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
    const asNum = (v: unknown): number | undefined => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const asArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    const builtPages = Array.isArray(f.builtPages)
      ? (f.builtPages as Array<{ file?: unknown; mtime?: unknown }>)
          .map(p => ({ file: asStr(p?.file), mtime: Number(p?.mtime ?? 0) }))
          .filter(p => p.file !== '')
      : [];
    const notesMtime = asNum(f.notesMtime);
    const sinceMs = asNum(f.sinceMs);

    // ★ 2026-10-19（`give-her-a-publish-tool`）：能不能进 publish 阶段，同样**按任务来源**判
    const existing = core.memoryManager.getProjectTask(id);
    if (!existing) return reply.code(404).send({ ok: false, error: `没有这个任务：${id}` });

    const out = core.memoryManager.advanceProjectTaskLoop(
      id,
      {
        notes: asStr(f.notes),
        drafts: asArr(f.drafts),
        shots: asArr(f.shots),
        builtPages,
        published: f.published === true,
        // 两个都缺 ⇒ `advanceLoop` 按老行为处理（不破坏旧调用方）
        ...(notesMtime !== undefined ? { notesMtime } : {}),
        ...(sinceMs !== undefined ? { sinceMs } : {}),
      },
      {
        allowPublish: allowPublishForTask(existing),
        // ★ 2026-10-19：只允许**当前认领批次**推进（防重放/乱序把阶段推错）
        ...(typeof (req.body as { claimToken?: unknown })?.claimToken === 'number'
          ? { claimToken: (req.body as { claimToken: number }).claimToken }
          : {}),
      },
    );
    if (!out) return reply.code(404).send({ ok: false, error: `没有这个任务：${id}` });
    logger.info(
      `[project-task] ${id} 阶段推进：→ ${out.decision.next}` +
        `${out.decision.done ? `（完成：${out.decision.outcome}）` : ''} · ${out.decision.detail}`,
    );
    return { ok: true, decision: out.decision, task: out.task };
  });

  app.get('/api/project-tasks/:id', async (req, reply) => {    const { id } = req.params as { id: string };
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
    const before = core.memoryManager.getProjectTask(id);
    if (!before) return reply.code(404).send({ ok: false, error: `没有这个任务：${id}` });

    /**
     * ★ 2026-10-19（change: `wake-her-on-task-result`）：
     * 终态与**结果事件**同一事务落库，之后由 `al:subagent-wake` 唤起她。
     * 旧的一次性通知只在 `subagentWake=false`（回退开关）时执行。
     */
    const event = wakeEnabled ? buildResultEvent(before, status, b ?? {}) : undefined;
    const task = core.memoryManager.submitProjectTaskResult(id, {
      status: status as 'needs_review' | 'completed' | 'failed' | 'unknown',
      dshSessionId: typeof b?.dshSessionId === 'string' && b.dshSessionId ? b.dshSessionId : undefined,
      result: b?.result,
      artifacts: Array.isArray(b?.artifacts) ? b.artifacts : undefined,
      error: typeof b?.error === 'string' ? b.error : undefined,
      // ★ claimToken：只接受**当前认领批次**的结果（回收重认领后，旧批次的迟到回传会被拒）
      ...(typeof b?.claimToken === 'number' ? { claimToken: b.claimToken } : {}),
      ...(event
        ? {
            event: {
              eventId: event.eventId,
              taskId: event.taskId,
              projectId: event.projectId,
              revision: event.revision,
              kind: 'result',
              payload: event.payload as unknown as Record<string, unknown>,
            },
          }
        : {}),
    });
    if (!task) {
      return reply.code(409).send({
        ok: false,
        error: `任务 ${id} 不在 running / 不是当前批次（可能已被回收重认领，或这是一次迟到的回传）——未写入`,
      });
    }
    logger.info(
      `[project-task] ${id} → ${task.status}${task.dshSessionId ? `（工程会话 ${task.dshSessionId}）` : ''}` +
        (event ? ` · 已入队结果事件 ${event.eventId}` : ' · 唤醒关闭，走旧通知路径'),
    );
    if (!wakeEnabled) {
      // 回退路径：记进记忆 + 一次性通知 + 直接推送（旧行为，一个开关退回去）
      void notifyProjectTaskResult(task);
    }
    return { ok: true, task, ...(event ? { eventId: event.eventId } : {}) };
  });

  /**
   * ★ 2026-10-19（change: `wake-her-on-task-result`）：**验收**。
   *
   * 与 `/result` 的分工：那是**执行方**说「跑完了」，这是**她（主 Agent）**说「我认了」。
   * 一条记录里三个状态必须可区分：`status`（跑没跑完）/ `accepted_at`（认没认）/ `notified_at`（说没说）。
   */
  app.post('/api/project-tasks/:id/accept', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown> | undefined;
    const revision = typeof b?.revision === 'number' ? Math.trunc(b.revision) : NaN;
    if (!Number.isFinite(revision) || revision < 0) {
      return reply.code(400).send({ ok: false, error: 'revision 必须是 ≥0 的整数' });
    }
    const out = core.memoryManager.acceptProjectTask(id, {
      revision,
      by: typeof b?.by === 'string' && b.by ? b.by : 'main-agent',
      ...(typeof b?.note === 'string' && b.note ? { note: b.note } : {}),
    });
    if (!out.task) return reply.code(404).send({ ok: false, error: `没有这个任务：${id}` });
    if (!out.accepted) {
      return reply.code(409).send({ ok: false, error: out.reason ?? '验收未通过', task: out.task });
    }
    logger.info(`[project-task] ${id} r${revision} 已验收（${out.reason ?? 'ok'}）`);
    return { ok: true, task: out.task };
  });

  /**
   * 记忆检索 —— dsh 记忆回传的**读通道**（change: bridge-memory-read）。   *
   * ★ 与聊天管线**同一套组装**（`read()` + `assembleWithReport()`；2026-10-24 起用报告版，
   *   以便日志区分「匹配数」与「注入数」）：
   *   各写各的会让她在 dsh 里和 QQ 里记起不同的东西
   *   （同 `getCompactPersonaPrompt` 的教训——「人设/记忆文本长什么样」只能有一处定义）。
   *
   * 用 POST 而非 GET：query 是用户原话，可能很长，且不该进 URL/日志历史。
   */
  app.post('/api/memory/read', async (req) => {
    const body = req.body as
      | { query?: unknown; mode?: unknown; blocks?: unknown; worldbookScope?: unknown; limit?: unknown; sessionId?: unknown }
      | undefined;

    const query = typeof body?.query === 'string' ? body.query : '';
    const mode = body?.mode === 'code' ? 'code' : 'chat';
    // ★ 2026-10-24（change: align-dsh-memory-blocks-with-scope）：把 `mode` 的一词三义拆开。
    //   `blocks` 只选块表；`worldbookScope` 只选世界书 scope，且**显式给出才注入**。
    //   不传 = 旧行为（逐字不变），所以老调用方零影响。
    const blocks = body?.blocks === 'code' ? 'code' : body?.blocks === 'chat' ? 'chat' : undefined;
    const worldbookScope =
      body?.worldbookScope === 'code' ? 'code' : body?.worldbookScope === 'chat' ? 'chat' : undefined;
    const rawLimit = typeof body?.limit === 'number' && Number.isFinite(body.limit) ? body.limit : 5;
    const limit = Math.min(Math.max(1, Math.trunc(rawLimit)), 20);
    const sessionId = typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : undefined;

    // ★ 空 query 也照常返回：`[关于你]`/`[你的偏好]`/`[关于你的事实]` 等块
    //   **不依赖 query**（直接读 store）。dsh 侧挂载预热正是靠这一点，
    //   否则第一轮会是一片空白（provider 同步，等不到异步检索）。
    // ★ 注意：`blocks` **不传给 `read()`** —— 它只决定用哪张块表，属于**组装**的事；
    //   `read()` 只负责按 scope 匹配。曾经把它塞进 `MemoryReadRequest`，
    //   但那边从头到尾没读过它（"看着接上其实没接"，F10），已删。
    const read = await core.memoryManager.read({ query, mode, worldbookScope, limit });
    const report = await core.memoryManager.assembleWithReport(
      mode, read.worldbook_triggers, read.retrieved, sessionId, { blocks, worldbookScope },
    );

    // ★ 2026-10-24：**匹配**与**注入**必须分开打 ——
    //   以前只有"worldbook N 条"，于是"匹配到了但一条没进 prompt"看起来跟成功完全一样，
    //   dsh 的世界书就这样一直没生效（2026-10-02 上线 → 2026-10-24 发现，22 天）。
    logger.info(
      `[memory/read] query=${JSON.stringify(query.slice(0, 24))} → 召回 ${read.retrieved.length} 条` +
      ` / worldbook 匹配 ${read.worldbook_triggers.length} 注入 ${report.worldbookInjected} 条` +
      ` / blocks=${blocks ?? mode}${worldbookScope ? ` scope=${worldbookScope}` : ''}` +
      ` / context ${report.text.length} 字` +
      (report.dropped.length ? ` / 预算丢弃 ${report.dropped.join(',')}` : ''),
    );
    return { context: report.text, retrieved: read.retrieved };
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
