/**
 * ★ 2026-10-20（change: guard-session-extract-endpoint；KI-18）
 *
 * `POST /api/sessions/:id/extract` 此前**对 id 一个字都不看**，而同文件邻居都有边界
 * （`/api/ingest` 只收 `dsh:`、archive/delete 只收 `webui:`）。
 * 后果：任何过了鉴权的调用方都能对**任意会话**触发结算（摘要 + 画像 + 人格确认，全是真 LLM 调用）。
 *
 * 本测试锁三道：
 *   ① `dsh:unknown` 拒（它不是真实会话 id，是适配器的退化桶）
 *   ② 零事件 ⇒ 404（「会话不存在」不许长得像「提取成功」）
 *   ③ 正常会话仍走原路（别为了安全把合法用法砍掉）
 */
import { describe, it, expect, vi } from 'vitest';
import { createWebuiApp } from '../src/webui/server.js';

function harness(eventCount: number) {
  const mm = {
    countSessionEvents: vi.fn(() => eventCount),
    extractProfile: vi.fn(async () => ({ factsExtracted: 2, summaryGenerated: true })),
  };
  return { mm, core: { memoryManager: mm } };
}

async function buildApp(core: any) {
  const app = createWebuiApp(core, { requireAuth: false, projects: {} } as never);
  await app.ready();
  return app;
}

describe('/api/sessions/:id/extract —— 入口校验', () => {
  it('正常会话：仍调 extractProfile 并原样返回', async () => {
    const h = harness(5);
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/sessions/webui%3As1/extract' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ factsExtracted: 2, summaryGenerated: true });
    expect(h.mm.extractProfile).toHaveBeenCalledWith('webui:s1');
  });

  it('★ 零事件 ⇒ 404（不是成功形状的空转）', async () => {
    const h = harness(0);
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/sessions/dsh%3Anot-exist/extract' });

    expect(res.statusCode).toBe(404);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toContain('没有任何事件');
    expect(h.mm.extractProfile, '零事件绝不能进结算').not.toHaveBeenCalled();
  });

  it('★ dsh:unknown ⇒ 400 且拒绝结算', async () => {
    const h = harness(99); // 就算它真有事件也不许结算
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/sessions/dsh%3Aunknown/extract' });

    expect(res.statusCode).toBe(400);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toContain('dsh:unknown');
    expect(h.mm.extractProfile).not.toHaveBeenCalled();
  });

  it('畸形 id（解码后含 /）⇒ 400，不进结算', async () => {
    const h = harness(3);
    const app = await buildApp(h.core);
    const res = await app.inject({ method: 'POST', url: '/api/sessions/a%2Fb/extract' });

    expect(res.statusCode).toBe(400);
    expect(h.mm.extractProfile).not.toHaveBeenCalled();
  });
});
