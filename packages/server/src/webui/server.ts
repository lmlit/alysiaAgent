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
 *   GET  /api/stats               — Token 用量
 *   GET  /api/roles               — 角色列表
 *   GET  /api/knowledge           — 知识库文档列表
 *   GET  /api/stickers            — 表情包列表
 *   POST /api/sessions/:id/extract   — 手动提取画像（LLM 异步）
 *   POST /api/roles/switch         — 切换激活角色
 *   POST /api/persona/adjust       — 手动调整人格参数
 *   POST /api/knowledge/import     — 导入知识
 *   DELETE /api/knowledge/:id      — 删除知识文档
 *   POST /api/privacy              — 隐私模式开关
 */
import Fastify from 'fastify';
import type { AlysiaCore } from '@alysia/core';

export function createWebuiApp(core: AlysiaCore) {
  const app = Fastify({ logger: false });

  // ── 系统 ──────────────────────────────────────────
  app.get('/api/health', async () => ({ status: 'ok', uptime: process.uptime() }));

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
    // getSessionStats 是模块级函数；通过 import 获取
    const { getSessionStats } = await import('@alysia/core/pipeline');
    // 返回所有已知会话的统计 + 全局汇总
    const sessions = core.memoryManager.listSessions(100);
    const perSession: Record<string, unknown> = {};
    let globalInput = 0;
    let globalOutput = 0;
    let globalTokens = 0;
    for (const s of sessions) {
      // 尝试查 stat（key 为 unifiedMsgOrigin）
      const stat = (getSessionStats as any)(s.sessionId) || { recordCount: 0, totalInput: 0, totalOutput: 0, totalTokens: 0 };
      perSession[s.sessionId] = stat;
      globalInput += stat.totalInput;
      globalOutput += stat.totalOutput;
      globalTokens += stat.totalTokens;
    }
    return { global: { input: globalInput, output: globalOutput, tokens: globalTokens }, perSession };
  });

  // ── 角色系统 ───────────────────────────────────────
  app.get('/api/roles', async () => {
    const roles = core.memoryManager.listRoles();
    const active = core.memoryManager.getActiveRoleId();
    return { roles, activeRole: active };
  });

  app.post('/api/roles/switch', async (req) => {
    const { roleId } = req.body as { roleId: string };
    core.memoryManager.switchRole(roleId);
    return { activeRole: core.memoryManager.getActiveRoleId() };
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

  // ── 隐私模式 ───────────────────────────────────────
  app.post('/api/privacy', async (req) => {
    const { mode } = req.body as { mode: 'off' | 'readonly' | 'full' };
    core.memoryManager.setPrivacyMode(mode);
    return { privacyMode: core.memoryManager.getPrivacyMode() };
  });

  return app;
}
