/**
 * 各域 API — 端点对应 docs/Web-API-Design.md
 * 扩展点：二期新增域（世界书/知识库/角色…）在此加一个导出，不碰 client。
 */
import { api } from './client';
import type {
  HealthResponse,
  LifeCompanionsResponse,
  LifeResponse,
  LifeSummariesResponse,
  LifeTemplatesResponse,
  MessagesResponse,
  PendingResponse,
  PersonaResponse,
  ProfileResponse,
  SessionsResponse,
  StatsResponse,
  StickersResponse,
} from './types';

// ── 系统 ──────────────────────────────────────────────
export const sysApi = {
  /** health 豁免鉴权，用来判断"server 起没起" */
  health: () => api.get<HealthResponse>('/api/health'),
};

// ── AI 主动生活 ────────────────────────────────────────
export const lifeApi = {
  /** 快照 + 近 N 天事件（服务端固定 7 天） */
  get: () => api.get<LifeResponse>('/api/life'),
  /** 生活素材库（她的日常从这些种子/自创活动里长出来） */
  templates: () => api.get<LifeTemplatesResponse>('/api/life/templates'),
  /** 近 7 天每日生活摘要（旧 → 新） */
  summaries: () => api.get<LifeSummariesResponse>('/api/life/summaries'),
  /** 配角在场状态（含离场） */
  companions: () => api.get<LifeCompanionsResponse>('/api/life/companions'),
};

// ── 画像 / 记忆纠正 ────────────────────────────────────
export const profileApi = {
  get: () => api.get<ProfileResponse>('/api/profile'),
  /**
   * ★ 连**已作废**的事实一起取（2026-10-16，记忆纠正首版）。
   *   纠正页需要看到"被作废的那条"，否则用户没法确认「旧事实真的失效了」。
   *   ⚠️ 默认的 `get()` **不含**已作废的 —— 那是画像展示用的。
   */
  getAll: () => api.get<ProfileResponse>('/api/profile?includeSuperseded=1'),
  /**
   * ★ 纠正一条用户事实：旧的作废 + 写入新的。
   *   `superseded=false` 表示**没找到旧事实**（不是失败）——旧文案可能已被改写过。
   */
  correctFact: (oldFact: string, newFact: string) =>
    api.post<{ ok: boolean; superseded: boolean; added: boolean }>('/api/profile/facts/correct', {
      oldFact,
      newFact,
    }),
  /** ★ 让一条事实失效（`stillValid:false`）。`found=false` = 没找到这条。 */
  confirmFact: (fact: string, stillValid: boolean) =>
    api.post<{ ok: boolean; found: boolean }>('/api/profile/facts/confirm', { fact, stillValid }),
};

// ── 人格 ──────────────────────────────────────────────
export const personaApi = {
  get: () => api.get<PersonaResponse>('/api/persona'),
};

// ── 会话 ──────────────────────────────────────────────
export const sessionApi = {
  list: () => api.get<SessionsResponse>('/api/sessions'),
  /** 归档（软删除：列表消失、数据保留）——服务端只允许 webui: 前缀的会话 */
  archive: (id: string) => api.post(`/api/sessions/${encodeURIComponent(id)}/archive`),
  /** 彻底删除（清事件流 + 摘要 + 向量）——同样只允许 webui: 会话 */
  remove: (id: string) => api.del(`/api/sessions/${encodeURIComponent(id)}`),
};

// ── 聊天 ──────────────────────────────────────────────
export const chatApi = {
  /** 历史分页。返回**时间倒序**（最新在前），展示前要 reverse */
  messages: (id: string, limit = 100, before?: string) =>
    api.get<MessagesResponse>(
      `/api/sessions/${encodeURIComponent(id)}/messages?limit=${limit}${
        before ? `&before=${encodeURIComponent(before)}` : ''
      }`,
    ),
  /** 会话是否有在途生成（刷新页面后恢复"回复中"状态） */
  pending: (id: string) =>
    api.get<PendingResponse>(`/api/chat/pending?sessionId=${encodeURIComponent(id)}`),
};

// ── 统计 ──────────────────────────────────────────────
export const statsApi = {
  get: () => api.get<StatsResponse>('/api/stats'),
};

// ── 表情包 ────────────────────────────────────────────
export const stickerApi = {
  list: () => api.get<StickersResponse>('/api/stickers'),
  /**
   * 图片直链 —— 给 `<img src>` 用。**不是** JSON 请求，所以不走 api client。
   *
   * ★ 为什么用 `/api/stickers/file/:name` 而不是响应里的 `path`：
   *   `path` 是服务端登记值（形如 `/data/stickers/x.webp`），只有在
   *   "服务端真把 data/ 当静态目录挂出来"的部署里才取得到 ——
   *   实测本部署直接请求它 **404**，必须走这个专门路由。
   */
  fileUrl: (name: string) => `/api/stickers/file/${encodeURIComponent(name)}`,
};
