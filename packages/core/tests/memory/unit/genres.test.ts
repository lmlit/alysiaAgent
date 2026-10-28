/**
 * ★ 2026-10-28（change: `extract-prompt-genres`；P8 第 4 步）
 *
 * 体裁表的守卫：
 *   1. 8 个 id 一个不多一个不少（新增链路必须登记）；
 *   2. 预算/采样/persona 指向哪里（防止表漂移）；
 *   3. `forbids` 只写合法块 key（拼错 = 约束形同虚设）。
 */
import { describe, it, expect } from 'vitest';
import {
  GENRES, GENRE_IDS, getGenre,
} from '../../../src/memory/genres';
import { CHAT_BLOCK_ORDER } from '../../../src/memory/block-registry';
import { DEFAULT_SAMPLING } from '../../../src/provider/sampling';

const EXPECTED = [
  'chat', 'code', 'life-event', 'life-daily',
  'proactive', 'session-summary', 'profile-extract', 'profile-rewrite',
];

describe('GENRES —— 8 个体裁', () => {
  it('id 集合完整且无重复', () => {
    expect([...GENRE_IDS].sort()).toEqual([...EXPECTED].sort());
    expect(new Set(GENRE_IDS).size).toBe(GENRE_IDS.length);
  });

  it('chat / code 的预算来自体裁表（3200 / 2450）', () => {
    expect(GENRES.chat.budgetTokens).toBe(3200);
    expect(GENRES.code.budgetTokens).toBe(2450);
  });

  it('非法组合表达不出来：code 禁止人味块', () => {
    expect(GENRES.code.forbids).toEqual(expect.arrayContaining([
      'basics', 'preferences', 'facts', 'characterFacts', 'pendingConfirm',
      'recentConversations', 'brevity',
    ]));
    expect(GENRES.chat.forbids).toEqual([]);
  });

  it('forbids 里的 key 都是合法块 key（拼错会红）', () => {
    const valid = new Set(CHAT_BLOCK_ORDER);
    for (const spec of Object.values(GENRES)) {
      for (const key of spec.forbids) {
        expect(valid.has(key as never), `${spec.id} 的 forbids 含未知 key: ${key}`).toBe(true);
      }
    }
  });

  it('采样槽指向 DEFAULT_SAMPLING 的对应槽', () => {
    expect(GENRES.chat.sampling).toBe(DEFAULT_SAMPLING.chat);
    expect(GENRES.code.sampling).toBe(DEFAULT_SAMPLING.chat);
    expect(GENRES['life-event'].sampling).toBe(DEFAULT_SAMPLING.life.generateEvent);
    expect(GENRES['life-daily'].sampling).toBe(DEFAULT_SAMPLING.life.generateSummary);
    expect(GENRES.proactive.sampling).toBe(DEFAULT_SAMPLING.proactive.personalize);
    expect(GENRES['session-summary'].sampling).toBe(DEFAULT_SAMPLING.session.summary);
    expect(GENRES['profile-extract'].sampling).toBe(DEFAULT_SAMPLING.profile.extract);
    expect(GENRES['profile-rewrite'].sampling).toBe(DEFAULT_SAMPLING.profile.deepRewrite);
  });

  it('persona 注入方式是单值，不是布尔组合', () => {
    expect(GENRES.chat.persona).toEqual({ kind: 'compact', sections: 4 });
    expect(GENRES.code.persona).toEqual({ kind: 'inline-one-line' });
    expect(GENRES.proactive.persona).toEqual({ kind: 'name-tone' });
    expect(GENRES['session-summary'].persona).toEqual({ kind: 'none' });
  });

  it('未知 id 直接抛，不静默回落', () => {
    expect(() => getGenre('nope' as never)).toThrow(/unknown genre/);
  });
});
