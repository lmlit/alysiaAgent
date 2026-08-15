/**
 * 各域 API(扩展点:二期编程模式 = 新增 programming.ts,不碰现有域)
 * 端点对应 docs/Web-API-Design.md
 */
import { api } from './client';

// ── 系统 ──────────────────────────────────────────────
export const sysApi = {
  health: () => api.get<{ status: string; uptime: number }>('/api/health'),
};

// ── 会话 ──────────────────────────────────────────────
export const sessionApi = {
  list: () => api.get<{ sessions: Array<{ sessionId: string; messageCount: number; lastActive: string }> }>('/api/sessions'),
  messages: (id: string, limit = 50, before?: string) =>
    api.get<{ messages: Array<{ role: string; content: string; senderName: string; createdAt?: string }>; hasMore: boolean }>(
      `/api/sessions/${encodeURIComponent(id)}/messages?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    ),
  remove: (id: string) => api.del(`/api/sessions/${encodeURIComponent(id)}`),
  archive: (id: string) => api.post(`/api/sessions/${encodeURIComponent(id)}/archive`),
};

// ── 画像 ──────────────────────────────────────────────
export const profileApi = {
  get: () => api.get('/api/profile'),
};

// ── 人格 ──────────────────────────────────────────────
export const personaApi = {
  get: () => api.get('/api/persona'),
  adjust: (param: string, delta: number, reason?: string) =>
    api.post('/api/persona/adjust', { param, delta, reason }),
};

// ── 统计 ──────────────────────────────────────────────
export const statsApi = {
  get: () => api.get('/api/stats'),
};

// ── 角色 ──────────────────────────────────────────────
export const rolesApi = {
  list: () => api.get<{ roles: Array<{ role: string; name: string; isActive: boolean; worldbookCount: number }>; activeRole: string }>('/api/roles'),
  switch: (roleId: string) => api.post('/api/roles/switch', { roleId }),
  import: (pkg: unknown) => api.post('/api/roles/import', pkg),
  exportRole: (id: string) => api.get(`/api/roles/${encodeURIComponent(id)}/export`),
};

// ── 知识库 ────────────────────────────────────────────
export const knowledgeApi = {
  list: () => api.get<{ docs: Array<{ id: string; title: string; source: string; chunkCount: number; createdAt: string }> }>('/api/knowledge'),
  importDoc: (pkg: { title: string; content: string }) => api.post('/api/knowledge/import', pkg),
  remove: (id: string) => api.del(`/api/knowledge/${encodeURIComponent(id)}`),
};

// ── 生活 ──────────────────────────────────────────────
export const lifeApi = {
  snapshot: () => api.get<{ snapshot: { currentActivity: string; mood: string; intimacy: number }; events: Array<Record<string, unknown>> }>('/api/life'),
  templates: () => api.get<{ templates: Array<{ id: string; activity: string; type: string; weight: number; source: string }> }>('/api/life/templates'),
  addTemplate: (activity: string, type: 'chat' | 'internal') => api.post('/api/life/templates', { activity, type }),
  removeTemplate: (id: string) => api.del(`/api/life/templates/${encodeURIComponent(id)}`),
};

// ── 世界书 ────────────────────────────────────────────
export const worldbookApi = {
  list: () => api.get<{ entries: Array<{ id: string; triggerKeys: string[]; content: string; source: string; createdAt: string }> }>('/api/worldbook'),
  remove: (id: string) => api.del(`/api/worldbook/${encodeURIComponent(id)}`),
};

// ── 表情包 ────────────────────────────────────────────
export const stickersApi = {
  list: () => api.get<{ stickers: Array<{ name: string; path: string }> }>('/api/stickers'),
};

// ── 隐私 ──────────────────────────────────────────────
export const privacyApi = {
  set: (mode: 'off' | 'readonly' | 'full') => api.post('/api/privacy', { mode }),
};

// ── 聊天 ──────────────────────────────────────────────
export const chatApi = {
  prompt: (text: string, sessionId?: string) =>
    api.post<{ ok: boolean; sessionId?: string; reply?: string; error?: string }>('/api/chat/prompt', { text, sessionId }),
  pending: (sessionId: string) =>
    api.get<{ inFlight: boolean }>(`/api/chat/pending?sessionId=${encodeURIComponent(sessionId)}`),
};
