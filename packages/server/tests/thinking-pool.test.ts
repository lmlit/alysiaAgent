// tests/thinking-pool.test.ts — ★ 8-12 思考中文案池自称视角（thinking-pool-first-person）
// 主动发送的"思考中"提示自称必须第一人称（与对话回复一致），
// 禁止"昔涟"第三人称自称（用户反馈视角混乱）
import { describe, it, expect } from 'vitest';
import { THINKING_BY_CATEGORY } from '../src/adapters/qq-official.js';

describe('THINKING_BY_CATEGORY 文案池自称视角', () => {
  it('全部文案不含"昔涟"第三人称自称', () => {
    const entries = Object.entries(THINKING_BY_CATEGORY);
    expect(entries.length).toBeGreaterThan(0);
    for (const [cat, pool] of entries) {
      for (const t of pool) {
        expect(t, `[${cat}] ${t}`).not.toMatch(/昔涟/);
      }
    }
  });

  it('仍保留"人家"第一人称口癖（视角风格未丢）', () => {
    const all = Object.values(THINKING_BY_CATEGORY).flat().join('\n');
    expect(all).toMatch(/人家/);
  });
});
