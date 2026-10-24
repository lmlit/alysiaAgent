/**
 * 「此刻的你」块 —— 生活系统 → 说话素材的**联动**（★ 2026-10-25，change: `make-her-talk-like-a-person`）
 *
 * 守的是**覆盖率**这件事：
 *   改之前窗口只有 **30 分钟**，而生活事件间隔是 **0.5–8h** ⇒ 绝大多数对话里这块是空的，
 *   "说话内容从生活系统里拿"在机制上接不上（素材在库里，但她手上没有）。
 *
 * 现在：3h 内 → 按时间差分档措辞；3h 内没有 → 退回「今天最近一条」。
 * ⚠️ 措辞分档是硬要求：**不能用"刚才"描述 3 小时前的事**（她自己都说不圆）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../../src/memory/MemoryManager';
import { initializeDatabase } from '../../../src/memory/database';
import type { IEmbedService } from '../../../src/memory/interfaces/IEmbedService';
import type { ILLMService } from '../../../src/memory/interfaces/ILLMService';

const mockEmbed: IEmbedService = { embed: async () => [0.1], dimension: () => 1 };
const mockLLM: ILLMService = { complete: async () => '{}' };

describe('getLifeContinuityBlock —— 生活 → 说话素材', () => {
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

  /** 直接插一条生活事件（绕过 LifeService，便于控制时间） */
  function insertEvent(id: string, minutesAgo: number, content: string, origin = 'regular') {
    const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    db.prepare(
      'INSERT OR REPLACE INTO ai_life_events (id, created_at, type, content, delivered, origin) VALUES (?,?,?,?,0,?)',
    ).run(id, at, 'internal', content, origin);
  }

  it('★ 30 分钟内的最近事件 → 「你刚才在」', () => {
    insertEvent('e1', 10, '在阳台晒了太阳');
    expect(mm.getLifeContinuityBlock()).toContain('你刚才在');
    expect(mm.getLifeContinuityBlock()).toContain('在阳台晒了太阳');
  });

  it('★ 2 小时前 → 「你不久前在」（不能说"刚才"）', () => {
    insertEvent('e1', 120, '在阳台晒了太阳');
    const block = mm.getLifeContinuityBlock();
    expect(block).toContain('你不久前在');
    expect(block, '2 小时前的事不能说"刚才"').not.toContain('刚才');
  });

  it('★ 5 小时前（今天）→ 「今天早些时候你在」—— 这是本次放宽窗口的核心收益', () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 3600_000);
    // 跨午夜时 5h 前可能已是"昨天"，那种情况落到下面那条用例，这里只在同一天断言
    if (fiveHoursAgo.getDate() !== new Date().getDate()) return;
    insertEvent('e1', 300, '在阳台晒了太阳');
    const block = mm.getLifeContinuityBlock();
    expect(block).toContain('今天早些时候你在');
    expect(block).not.toContain('刚才');
  });

  it('完全没有事件 → 空串（不编造）', () => {
    expect(mm.getLifeContinuityBlock()).toBe('');
  });

  it('followup（对话余波）事件不算"她在做的事"', () => {
    insertEvent('e1', 5, '刚才聊的那句话还在脑子里', 'followup');
    expect(mm.getLifeContinuityBlock(), '余波不是生活事件').toBe('');
  });

  it('多条事件取最近的', () => {
    insertEvent('e1', 100, '早些的事');
    insertEvent('e2', 5, '刚做的事');
    const block = mm.getLifeContinuityBlock();
    expect(block).toContain('刚做的事');
    expect(block).not.toContain('早些的事');
  });
});
