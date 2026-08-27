import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';

function makeManager(db: Database.Database): MemoryManager {
  const embedService = { embed: async () => [0], dimension: () => 1024 };
  const llmService = { complete: async () => '{}' };
  return new MemoryManager(db as any, null, embedService as any, llmService as any);
}

describe('PromptAssembler life injection', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    mm = makeManager(db);
  });

  it('assemble chat includes life block when events exist', async () => {
    mm.recordLifeEvent({ type: 'chat', content: '在阳台看书，看到一朵像兔子的云' });
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).toContain('[我的近期日常]');
    expect(prompt).toContain('兔子');
  });

  it('assemble chat omits life block when no events', async () => {
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).not.toContain('[我的近期日常]');
  });

  it('code mode also gets life block (AI carries its life into code mode)', async () => {
    mm.recordLifeEvent({ type: 'internal', content: '给自己倒了杯水' });
    const prompt = await mm.assembleWithWorldbook('code', [], []);
    expect(prompt).toContain('[我的近期日常]');
  });

  // ── ★ 8-28 画像事实时间标注（profile-facts-timestamps）──────────────

  it('facts 注入带时间标注：今天 → (今天)', async () => {
    const facts = [{
      fact: '用户在长沙', confidence: 0.9, evidence: '我在长沙', source_event: 'e1',
      updated_at: new Date().toISOString(), valid_from: new Date().toISOString(),
      source: 'user', valid_until: null, status: 'active',
    }];
    db.prepare('UPDATE user_profile SET facts = ? WHERE id = 1').run(JSON.stringify(facts));
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).toContain('- 用户在长沙 [你说过] (今天)');
  });

  it('facts 注入时间标注：3 天前 → (3天前)', async () => {
    const ts = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const facts = [{
      fact: '用户喜欢喝冰美式', confidence: 0.8, evidence: 'e', source_event: 'e1',
      updated_at: ts, valid_from: ts, source: 'behavior', valid_until: null, status: 'active',
    }];
    db.prepare('UPDATE user_profile SET facts = ? WHERE id = 1').run(JSON.stringify(facts));
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).toContain('- 用户喜欢喝冰美式 (3天前)');
  });

  it('facts 注入时间标注：超 30 天 → 显示 M月d日', async () => {
    const d = new Date(Date.now() - 40 * 86_400_000);
    const facts = [{
      fact: '用户以前在长沙住过', confidence: 0.7, evidence: 'e', source_event: 'e1',
      updated_at: d.toISOString(), valid_from: d.toISOString(), source: 'inferred',
      valid_until: null, status: 'active',
    }];
    db.prepare('UPDATE user_profile SET facts = ? WHERE id = 1').run(JSON.stringify(facts));
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).toContain(`(${d.getMonth() + 1}月${d.getDate()}日)`);
  });

  it('facts 无时间字段 → 不标注', async () => {
    const facts = [{ fact: '无时间字段的事实', confidence: 0.5, source: 'inferred', status: 'active' }];
    db.prepare('UPDATE user_profile SET facts = ? WHERE id = 1').run(JSON.stringify(facts));
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).toContain('- 无时间字段的事实(待确认)');
    // 无相对时间标注(今天/昨天/N天前/M月d日)
    expect(prompt).not.toMatch(/无时间字段的事实\(待确认\) *(今天|昨天|\d+天前|\d+月\d+日)/);
  });

  it('getProfileSnapshot 返回 updatedAt/validFrom（Web 画像页时间列）', async () => {
    const ts = new Date(Date.now() - 86_400_000).toISOString();
    db.prepare('UPDATE user_profile SET facts = ? WHERE id = 1').run(JSON.stringify([{
      fact: '用户在测试', confidence: 1, evidence: 'e', source_event: 'e1',
      updated_at: ts, valid_from: ts, source: 'user', valid_until: null, status: 'active',
    }]));
    const snap = mm.getProfileSnapshot();
    expect(snap.facts[0].updatedAt).toBe(ts);
    expect(snap.facts[0].validFrom).toBe(ts);
  });

  // ── ★ 8-28 过期确认（profile-facts-classification-confirm）──────────

  it('待确认事实注入【待确认的事实】块（过期 1 天内，≤2 条，含记录时间）', async () => {
    const now = Date.now();
    const facts = [
      {
        fact: '用户之前玩绝区零', confidence: 0.8, evidence: 'e', source_event: 'e1',
        updated_at: new Date(now - 20 * 86_400_000).toISOString(),
        valid_from: new Date(now - 20 * 86_400_000).toISOString(),
        valid_until: new Date(now - 86_400_000).toISOString(), // 过期 1 天
        source: 'inferred', status: 'active', category: 'status',
      },
      {
        fact: '用户以前在长沙', confidence: 0.9, evidence: 'e', source_event: 'e2',
        updated_at: new Date(now - 100 * 86_400_000).toISOString(),
        valid_from: new Date(now - 100 * 86_400_000).toISOString(),
        valid_until: new Date(now - 2 * 86_400_000).toISOString(), // 过期 2 天
        source: 'user', status: 'active', category: 'identity',
      },
      {
        fact: '用户尚未过期的事实', confidence: 0.9, evidence: 'e', source_event: 'e3',
        updated_at: new Date().toISOString(), valid_from: new Date().toISOString(),
        valid_until: new Date(now + 86_400_000).toISOString(), // 未过期
        source: 'user', status: 'active', category: 'identity',
      },
    ];
    db.prepare('UPDATE user_profile SET facts = ? WHERE id = 1').run(JSON.stringify(facts));
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).toContain('[待确认的事实]');
    // 只检查【待确认】块内部（未过期事实会正常出现在【关于你的事实】块，不算错）
    const pendingSection = prompt.split('[待确认的事实]')[1]?.split('\n\n')[0] ?? '';
    expect(pendingSection).toContain('用户之前玩绝区零');
    expect(pendingSection).toContain('用户以前在长沙');
    expect(pendingSection).not.toContain('用户尚未过期的事实');
    expect(pendingSection).toContain('confirm_profile_fact');
  });

  it('无过期事实 → 不注入待确认块', async () => {
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).not.toContain('[待确认的事实]');
  });

  it('过期超 3 天 → 清理为 expired，不注入', async () => {
    const now = Date.now();
    db.prepare('UPDATE user_profile SET facts = ? WHERE id = 1').run(JSON.stringify([{
      fact: '用户很久前的旧习惯', confidence: 0.8, evidence: 'e', source_event: 'e1',
      updated_at: new Date(now - 40 * 86_400_000).toISOString(),
      valid_from: new Date(now - 40 * 86_400_000).toISOString(),
      valid_until: new Date(now - 5 * 86_400_000).toISOString(), // 过期 5 天
      source: 'inferred', status: 'active', category: 'general',
    }]));
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).not.toContain('[待确认的事实]');
    // 已被清理为 expired
    const snap = mm.getProfileSnapshot();
    expect(snap.facts.find(f => f.fact === '用户很久前的旧习惯')?.status).toBe('expired');
  });
});
