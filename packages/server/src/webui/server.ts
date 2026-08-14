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
import { registerChatRoutes } from './chat.js';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export function createWebuiApp(core: AlysiaCore) {
  const app = Fastify({ logger: false });
  // ★ 8-15 WebUI 聊天端点（webui-chat-endpoints）：prompt/stream/messages/pending
  registerChatRoutes(app, core);

  // ── 系统 ──────────────────────────────────────────
  app.get('/api/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  // ★ 8-15 WebUI 静态托管(生产形态:同源 serve 整个 dist——assets/模型/pet.html 全量;
  //   未知路径回退 index.html(hash 路由);dev 用 vite dev server 5173 代理 /api)
  const webuiDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../../webui/dist');
  const MIME: Record<string, string> = {
    html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css',
    json: 'application/json', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', wasm: 'application/wasm',
    'model3.json': 'application/json', moc3: 'application/octet-stream', exp3: 'application/json',
    physics3: 'application/json', mp3: 'audio/mpeg', wav: 'audio/wav', zst: 'application/octet-stream',
  };
  // Fastify v5 无 '/*' 通配路由 → 用 setNotFoundHandler 兜底静态文件(排除 /api)
  if (existsSync(join(webuiDist, 'index.html'))) {
    app.setNotFoundHandler(async (req: any, reply: any) => {
      const url = String(req?.url ?? '/').split('?')[0];
      if (url.startsWith('/api/')) {
        return reply.code(404).send({ ok: false, error: 'not found' });
      }
      const pathname = decodeURIComponent(url.replace(/^\//, ''));
      let filePath = resolve(webuiDist, pathname || 'index.html');
      // 防目录穿越
      if (!filePath.startsWith(webuiDist)) return reply.code(403).send({ ok: false });
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = join(webuiDist, 'index.html');
      }
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
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

  app.post('/api/sessions/:id/extract', async (req) => {
    const { id } = req.params as { id: string };
    const result = await core.memoryManager.extractProfile(id);
    return result;
  });

  // ── 画像 ──────────────────────────────────────────
  app.get('/api/profile', async () => core.memoryManager.getProfileSnapshot());

  // ── 人格 ──────────────────────────────────────────
  app.get('/api/persona', async () => core.memoryManager.getPersonaSnapshot());

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
    core.memoryManager.deleteKnowledgeDoc((req.params as any).id);
    return { ok: true };
  });

  // ── 表情包 ─────────────────────────────────────────
  app.get('/api/stickers', async () => core.memoryManager.listStickers());

  // ★ 8-15 表情包文件（聊天视图 [表情包:名字] 渲染用）
  app.get('/api/stickers/file/:name', async (req, reply) => {
    const s = core.memoryManager.findSticker((req.params as any).name);
    if (!s?.content) return reply.code(404).send({ ok: false, error: 'sticker not found' });
    try {
      const { readFileSync } = await import('fs');
      const data = readFileSync(s.content);
      const ext = s.content.split('.').pop()?.toLowerCase() ?? '';
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

  // ── ★ 8-14 内容自进化（content-self-evolution）：硬审计面 + 用户事后删除兜底 ──
  app.get('/api/worldbook', async () => ({ entries: core.memoryManager.listWorldbookEntries() }));

  app.delete('/api/worldbook/:id', async (req) => {
    const ok = core.memoryManager.deleteWorldbookEntry((req.params as any).id);
    return { ok };
  });

  app.get('/api/life/templates', async () => ({ templates: core.memoryManager.listLifeTemplates() }));

  app.delete('/api/life/templates/:id', async (req) => {
    const ok = core.memoryManager.deleteLifeTemplate((req.params as any).id);
    return { ok };
  });

  return app;
}
