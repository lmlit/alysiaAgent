/**
 * 提示词资产守卫（`src/prompts/`）。
 *
 * ★ 为什么值得为「几个常量」写测试：
 *   提示词被误删/截断/改写时**不会有任何报错**——编译通过、启动正常、
 *   测试全绿，只是她的行为悄悄变差（生活事件丢掉真实感约束、承诺裁决丢掉三选一……）。
 *   这正是本项目反复栽的那类「静默劣化」。
 *
 * 这里不锁全文（改了全文测试只会变成复读机），只锁**每条提示词的关键约定**——
 * 那是它存在的理由，丢了才是真的坏了。
 */

import { describe, it, expect } from 'vitest';
import {
  LIFE_EVENT_PROMPT,
  LIFE_SUMMARY_PROMPT,
  LIFE_INTENT_PROMPT,
  LIFE_MOOD_NOTE_PROMPT,
  LIFE_REFLECTION_PROMPT,
} from '../src/prompts/life.js';

const ALL = {
  LIFE_EVENT_PROMPT,
  LIFE_SUMMARY_PROMPT,
  LIFE_INTENT_PROMPT,
  LIFE_MOOD_NOTE_PROMPT,
  LIFE_REFLECTION_PROMPT,
};

describe('提示词资产 / 通用', () => {
  it('五段都在，且都不是被截断的残句', () => {
    for (const [name, text] of Object.entries(ALL)) {
      expect(typeof text, name).toBe('string');
      // 最短的是「情绪侧端」（~80 字），低于此值说明被清空或截断
      expect(text.length, `${name} 过短，疑似被清空/截断`).toBeGreaterThan(60);
      expect(text.trim(), name).toBe(text);
    }
  });

  it('要求 JSON 输出的槽位，提示词里必须含 "json" 字样', () => {
    // ★ API 硬约束：response_format=json_object 要求 prompt 里含 "json"，
    //   否则直接 400（本项目已踩过，见 memory-system spec §4.1.1 契约 2）。
    //   调用方（modules/life.ts）对这三段传了 responseFormat: 'json'。
    for (const name of ['LIFE_EVENT_PROMPT', 'LIFE_INTENT_PROMPT', 'LIFE_REFLECTION_PROMPT']) {
      expect(ALL[name as keyof typeof ALL].toLowerCase(), `${name} 缺 "json" 会被 API 400`).toContain('json');
    }
  });

  it('纯文本槽位的提示词**不得**要求 JSON', () => {
    // 反向守卫：给纯文本槽配上 JSON 模式同样会被 API 拒（prompt 里没有 "json"）
    expect(LIFE_SUMMARY_PROMPT).not.toContain('只输出 JSON');
    expect(LIFE_MOOD_NOTE_PROMPT).not.toContain('只输出 JSON');
  });
});

describe('提示词资产 / 各段的不可丢内容', () => {
  it('事件生成：生活切片 + 时辰贴合 + 真实感约束 + 事件/对话拆分', () => {
    // 这些是历次实测踩坑后补上的约束，丢任何一条都会让生活事件质量倒退
    for (const marker of ['生活切片', '时辰', '生活真实感约束', '对轻月说的话', 'agency', 'next_in_hours']) {
      expect(LIFE_EVENT_PROMPT, `丢了「${marker}」`).toContain(marker);
    }
  });

  it('每日摘要：第一人称 + 50 字以内 + 明确禁止 JSON', () => {
    // 复用 generateEvent 的 JSON 槽会把摘要存成 JSON 文本污染摘要层——这条禁止不能丢
    expect(LIFE_SUMMARY_PROMPT).toContain('50 字以内');
    expect(LIFE_SUMMARY_PROMPT).toContain('第一人称');
    expect(LIFE_SUMMARY_PROMPT).toContain('不要 JSON');
  });

  it('承诺裁决：三选一 + 延期上限 + 绝不静默消失', () => {
    for (const marker of ['fulfill', 'defer', 'cancel', 'delay_hours', '绝不静默消失']) {
      expect(LIFE_INTENT_PROMPT, `丢了「${marker}」`).toContain(marker);
    }
  });

  it('每日反思：反射 + 调整项 + 诚实优先', () => {
    for (const marker of ['reflection', 'adjustments', 'insight', '诚实优先']) {
      expect(LIFE_REFLECTION_PROMPT, `丢了「${marker}」`).toContain(marker);
    }
  });
});
