/**
 * ★ 2026-10-28（change: `add-production-trace-eval`）
 *
 * **生产形态回归**：把线上出现过的“单会话 + 高上下文 + 慢摘要 + 预算竞争”
 * 固化成可重复的测试，而不是等线上日志。
 *
 * 这里不测“某个函数返回什么”，测的是：
 *   1. 100 facts / 3 recent / 5 memories / life / 1.2k basics 同时存在时，谁会被 3,200 预算挤掉；
 *   2. 60s 一轮、持续 25 分钟时，10 分钟冷却是否真的只请求 3 次摘要；
 *   3. `skipped`（in-flight）不 hold 截断，`failed` 才 hold。
 *
 * ⚠️ 断言是**产品目标**，不是为了迁就现状：facts 绝不能被丢，
 *    recent/memories 至少要在预算允许范围内保住。改预算/上限时先看这里。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PromptAssembler } from '../../src/memory/PromptAssembler';
import { initializeDatabase } from '../../src/memory/database';
import { ProfileStore } from '../../src/memory/stores/ProfileStore';
import { PersonaStore } from '../../src/memory/stores/PersonaStore';
import { ConversationStore } from '../../src/memory/stores/ConversationStore';
import { KnowledgeStore } from '../../src/memory/stores/KnowledgeStore';
import { WorldbookStore } from '../../src/memory/stores/WorldbookStore';
import { CodeContextStore } from '../../src/memory/stores/CodeContextStore';
import {
  COMPACTION_COOLDOWN_MS,
  shouldHoldTruncation,
  shouldRequestCompaction,
} from '../../src/memory/compaction-scheduler';

const SID = 'qq-official-1:private:production-trace';
const NOW = '2026-10-28T12:00:00.000Z';

function fact(i: number) {
  return {
    fact: `事实${String(i).padStart(3, '0')}：用户的第 ${i} 条稳定信息`,
    confidence: 1 - i * 0.001,
    evidence: `证据 ${i}`,
    source_event: `evt-${i}`,
    updated_at: NOW,
    source: 'user' as const,
    valid_from: NOW,
    valid_until: null,
    status: 'active' as const,
    category: 'general' as const,
  };
}

describe('生产形态回归 —— 单会话 / 预算竞争 / 压缩节奏', () => {
  let db: Database.Database;
  let assembler: PromptAssembler;
  let profileStore: ProfileStore;
  let convStore: ConversationStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    profileStore = new ProfileStore(db);
    const personaStore = new PersonaStore(db);
    convStore = new ConversationStore(db, null);
    const knowledgeStore = new KnowledgeStore(db, null);
    const worldbookStore = new WorldbookStore(db);
    const codeContextStore = new CodeContextStore(db);

    const now = NOW;
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at) VALUES (1, '{}', '{}', '[]', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at) VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}', '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}', '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);

    assembler = new PromptAssembler(profileStore, personaStore, convStore, knowledgeStore, worldbookStore, codeContextStore);
  });

  afterEach(() => db.close());

  it('100 facts + 3 recent + 5 memories + life：facts/recent/memories 都不被预算丢掉', async () => {
    // 生产基线：basics ~1.2k 字、facts 100+、最近 3 段摘要、语义召回 5 条。
    // ★ 顺序很重要：先写 facts（会把 basics 标 stale），再 updateBasics 模拟
    //   Cron 已重写出新 basics —— 线上 `basicsStale=false` + 117 facts 并存的形态。
    profileStore.replaceFacts(Array.from({ length: 100 }, (_, i) => fact(i)));
    profileStore.updateBasics('关于用户的长期画像与近期状态。'.repeat(82));

    for (let i = 0; i < 3; i++) {
      await convStore.insert({
        id: `conv-${i}`,
        session_id: SID,
        summary: `第 ${i + 1} 段最近对话摘要：用户聊了工作、吃饭和睡觉。`,
        participants: '[]',
        topics: '[]',
        key_decisions: '[]',
        message_count: 4,
        started_at: new Date(Date.parse(NOW) - (i + 1) * 3600_000).toISOString(),
        ended_at: new Date(Date.parse(NOW) - i * 3600_000).toISOString(),
        embedding_id: null,
        summary_status: 'ok',
        facts_status: 'ok',
      });
    }

    const retrieved = Array.from({ length: 5 }, (_, i) => ({
      id: `mem-${i}`,
      score: 0.9 - i * 0.05,
      text: `相关记忆 ${i}：用户提过的事情`,
      metadata: {},
    }));

    const report = await assembler.assembleWithReport(
      'chat', retrieved, [], '【我的近期日常】\n- 今天在窗边晒太阳。', SID,
    );

    // 诊断：失败时把真实丢弃块打出来（含 token 尺寸）
    console.log('[eval] dropped =', report.dropped.join(', ') || '(none)');

    expect(report.dropped, `facts 被丢了：${report.dropped.join(', ')}`).not.toContain('facts');
    expect(report.text).toContain('[关于你的事实]');
    expect(report.text).toContain('[最近对话]');
    expect(report.text).toContain('[相关记忆]');
    expect(report.text).toContain('【我的近期日常】');

    const injected = report.text.match(/- 事实\d{3}/g) ?? [];
    expect(injected).toHaveLength(20); // FACTS_IN_PROMPT
  });

  it('60s 一轮 × 25min → 10min 冷却下只请求 3 次摘要', () => {
    const start = 1_700_000_000_000;
    let lastRequestAt: number | undefined;
    let requests = 0;

    for (let t = 0; t <= 25 * 60_000; t += 60_000) {
      const should = shouldRequestCompaction({
        inputTokens: 10_000,
        triggerTokens: 8_000,
        now: start + t,
        lastRequestAt,
        cooldownMs: COMPACTION_COOLDOWN_MS,
      });
      if (should) {
        requests++;
        lastRequestAt = start + t;
      }
    }

    expect(requests).toBe(3); // 0 / 10 / 20 分钟
  });

  it('skipped 不 hold 截断，failed 才 hold', () => {
    expect(shouldHoldTruncation('skipped')).toBe(false);
    expect(shouldHoldTruncation('ok')).toBe(false);
    expect(shouldHoldTruncation('failed')).toBe(true);
  });
});
