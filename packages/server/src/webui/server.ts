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
   *  不传 = 默认 packages/webui/dist（Vue 旧前端）。
   *  传 packages/console/out = 托管 Next.js 新前端（多页导出，路径映射不同）。
   *  目录不存在时静默回退默认值，保证"没构建也能用"。 */
  staticDist?: string;
}

export function createWebuiApp(core: AlysiaCore, opts: WebuiAuthOptions = {}) {
  const { webuiToken = '', requireAuth = false, staticDist } = opts;
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

  // ★ 8-15 WebUI 静态托管(生产形态:同源 serve 整个 dist——assets/模型/pet.html 全量;
  //   未知路径回退 index.html(hash 路由);dev 用 vite dev server 5173 代理 /api)
  // ★ 9-24 console-local-serve：支持托管 Next.js 新前端（多页静态导出）。
  //   两者路径映射不同，用「候选链」统一处理：
  //     webui(Vue hash SPA)：/anything → index.html
  //     console(Next export)：/life → life.html；未命中 → 404.html
  const defaultDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../../webui/dist');
  // 显式传入但产物不存在时回退默认值（"没构建也能用"，不 500）
  const dist = staticDist && existsSync(join(staticDist, 'index.html')) ? staticDist : defaultDist;
  if (staticDist && dist !== staticDist) {
    logger.warn(`[WebUI] staticDist 不存在或缺少 index.html，回退默认前端：${defaultDist}`);
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
  if (existsSync(join(dist, 'index.html'))) {
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
        // 未命中：Next 有 404.html 就用它（真 404 语义）；webui 回退 index.html（hash 路由）
        const fourOhFour = join(dist, '404.html');
        if (existsSync(fourOhFour)) {
          filePath = fourOhFour;
          status = 404;
        } else {
          filePath = join(dist, 'index.html');
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

  /**
   * 记忆检索 —— dsh 记忆回传的**读通道**（change: bridge-memory-read）。
   *
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

  // ── 画像 ──────────────────────────────────────────
  app.get('/api/profile', async () => core.memoryManager.getProfileSnapshot());

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
