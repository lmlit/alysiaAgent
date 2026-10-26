/**
 * 隐私模式三档**兑现**的守卫（★ 2026-10-25，change: `fulfill-privacy-mode`）
 *
 * 守的是 spec §4.6 那句承诺：「`readonly` = **本次对话不被长期记忆引用**」。
 *
 * 改之前：只做了"当次不注入"（`assembleMinimal`），`ingest` 照写、画像照提取
 * ⇒ 这段对话会在**下次正常对话**里被注入 —— 承诺没兑现，而且**看不出来**（没有报错）。
 *
 * 现在：`readonly` 时 ingest 给 payload 打 `skip_profile`（复用 `eligibility` 的现成判据），
 * 事件仍入库（可审计）、但不进画像/人格/嵌入 ⇒ 不会被召回。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../../src/memory/MemoryManager';
import { initializeDatabase } from '../../../src/memory/database';
import type { MemoryEvent } from '../../../src/memory/types';
import type { IEmbedService } from '../../../src/memory/interfaces/IEmbedService';
import type { ILLMService } from '../../../src/memory/interfaces/ILLMService';
import { createPrivacyCommand } from '../../../src/commands/privacy';

const mockEmbed: IEmbedService = { embed: async () => [0.1], dimension: () => 1 };
const mockLLM: ILLMService = { complete: async () => '{}' };

function evt(id: string, content = '今天聊了点私事'): MemoryEvent {
  return {
    id,
    session_id: 'sess-1',
    source: 'chat',
    type: 'message',
    payload: { role: 'user', content },
    importance: 0.5,
    created_at: new Date().toISOString(),
  };
}

describe('隐私模式 —— 三档兑现', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
      VALUES (1, '昔涟', '{}', '{}', '{}', '[]', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)`).run(now);
    mm = new MemoryManager(db, null, mockEmbed, mockLLM);
  });

  afterEach(() => db.close());

  const payloadOf = (id: string) =>
    JSON.parse((db.prepare('SELECT payload FROM events WHERE id = ?').get(id) as any).payload);
  const rowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n;

  it("off（默认）→ 照写，且**不打** skip_profile", async () => {
    await mm.ingest(evt('e1'));
    expect(rowCount()).toBe(1);
    expect(payloadOf('e1').skip_profile).toBeUndefined();
  });

  it('★ readonly → **入库存档**，但打 skip_profile（不学习、不召回）', async () => {
    mm.setPrivacyMode('readonly', 'sess-1');
    await mm.ingest(evt('e2'));
    expect(rowCount(), 'readonly 仍要写入 EventLog（可审计）').toBe(1);
    expect(payloadOf('e2').skip_profile, '这就是「不被长期记忆引用」的实现').toBe(true);
  });

  it('full → 连存档都不写', async () => {
    mm.setPrivacyMode('full', 'sess-1');
    await mm.ingest(evt('e3'));
    expect(rowCount()).toBe(0);
  });

  it('★ 恢复到 off 之后，新消息不再带标记（模式是"当次会话"的）', async () => {
    mm.setPrivacyMode('readonly', 'sess-1');
    await mm.ingest(evt('e4'));
    expect(mm.resetPrivacyMode('sess-1')).toBe(true);
    await mm.ingest(evt('e5'));
    expect(payloadOf('e5').skip_profile).toBeUndefined();
  });

  it('★ 别的会话结束**不该**清掉我在本会话开的隐私（原实现会）', () => {
    mm.setPrivacyMode('readonly', 'sess-1');
    expect(mm.resetPrivacyMode('sess-OTHER'), '不匹配的会话不恢复').toBe(false);
    expect(mm.getPrivacyMode()).toBe('readonly');
    expect(mm.resetPrivacyMode('sess-1')).toBe(true);
    expect(mm.getPrivacyMode()).toBe('off');
  });

  it('API 全局开启（无 sessionId）→ 任何会话结束都恢复', () => {
    mm.setPrivacyMode('full');
    expect(mm.resetPrivacyMode('随便哪个会话')).toBe(true);
    expect(mm.getPrivacyMode()).toBe('off');
  });

  it('已经是 off 时 reset 返回 false（不假装做了事）', () => {
    expect(mm.resetPrivacyMode('sess-1')).toBe(false);
  });
});

describe('/privacy 命令', () => {
  const fakeEvent = (sessionId = 'sess-1') => ({ unifiedMsgOrigin: sessionId }) as any;

  function cmd(initial: 'off' | 'readonly' | 'full' = 'off') {
    let mode = initial;
    const seen: Array<{ mode: string; sessionId: string }> = [];
    const c = createPrivacyCommand({
      getMode: () => mode,
      setMode: (m, sid) => { seen.push({ mode: m, sessionId: sid }); mode = m; return mode; },
    });
    return { c, seen, mode: () => mode };
  }

  it('无参数 → 报当前模式 + 用法（不猜用户想干啥）', async () => {
    const { c } = cmd('readonly');
    const out = await c.handler(fakeEvent(), []);
    expect(out).toContain('当前隐私模式：**readonly**');
    expect(out).toContain('/privacy off|readonly|full');
  });

  it('★ 切换后回执必须说清"这个模式做了什么"', async () => {
    const { c, mode } = cmd('off');
    const out = await c.handler(fakeEvent(), ['readonly']);
    expect(mode()).toBe('readonly');
    expect(out).toContain('不会被她引用');
    expect(out, '必须说清仍会存档 —— 否则用户以为全隐身').toContain('仍会存档');
  });

  it('非法值 → 说明合法值，且**当前模式没变**', async () => {
    const { c, mode } = cmd('off');
    const out = await c.handler(fakeEvent(), ['paranoid']);
    expect(mode()).toBe('off');
    expect(out).toContain('没有「paranoid」这个模式');
    expect(out).toContain('仍是 **off**');
  });

  it('会话 id 会带给 setMode（决定"谁结束时恢复"）', async () => {
    const { c, seen } = cmd();
    await c.handler(fakeEvent('sess-42'), ['full']);
    expect(seen[0]).toEqual({ mode: 'full', sessionId: 'sess-42' });
  });
});
