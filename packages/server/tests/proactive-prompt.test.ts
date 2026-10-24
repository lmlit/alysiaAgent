/**
 * 问候的 systemPrompt 组装（★ 2026-10-24，change: `unify-greeting-persona-source`）
 *
 * 守的是**人格来源唯一**这件事：
 *   改之前 systemPrompt 写死在 `modules/proactive.ts`，自带一句泛化身份
 *   「你是昔涟，一个温柔贴心的 AI 伴侣」——第三份人格、无人登记、改人格改不到它。
 *   现在身份与语气必须来自 DB（`getPersonaSnapshot()`）。**断言里特意反向检查
 *   那句写死的自我描述不许再出现** —— 否则这个洞会悄无声息地长回来。
 */
import { describe, it, expect } from 'vitest';
import {
  buildProactiveSystemPrompt,
  PROACTIVE_PERSONALIZE_TASK,
} from '../src/prompts/proactive.js';

const PERSONA = {
  name: '昔涟',
  tone: { formality: -0.2, warmth: 0.6, humor: 0.3, directness: 0.1 },
  speechStyle: { sentence_length: -0.1, emoji_usage: 0.4 },
  emotionalRange: { expressiveness: 0.5, empathy: 0.7 },
};

describe('buildProactiveSystemPrompt', () => {
  it('★ 身份与语气来自 DB（不是写死的自我描述）', () => {
    const p = buildProactiveSystemPrompt(PERSONA);
    expect(p).toContain('你是昔涟');
    // 逐个语气维度都要带出来 —— 这是"她的语气"在这一体裁里的唯一载体
    expect(p).toContain('温暖度=0.6');
    expect(p).toContain('幽默感=0.3');
    expect(p).toContain('形式度=-0.2');
    expect(p).toContain('表情使用=0.4');
    expect(p).toContain('共情=0.7');
  });

  it('★ 那句写死的「温柔贴心的 AI 伴侣」不许再出现', () => {
    const p = buildProactiveSystemPrompt(PERSONA);
    expect(p).not.toContain('温柔贴心');
    expect(p, '问候里不该自称 AI').not.toContain('AI 伴侣');
  });

  it('体裁约束在位：长度 30-60 + 只输出内容', () => {
    const p = buildProactiveSystemPrompt(PERSONA);
    expect(p).toContain('30-60 字');
    expect(p).toContain('只输出消息内容本身');
    expect(p).toContain(PROACTIVE_PERSONALIZE_TASK);
  });

  it('人格缺失/为空 → 仍产出可用文本，不出现 undefined', () => {
    for (const input of [undefined, null, {}, { name: '' }]) {
      const p = buildProactiveSystemPrompt(input as any);
      expect(p).toContain('30-60 字');
      expect(p).not.toContain('undefined');
      expect(p, '没有名字时退化为"她"，而不是空字符串').toContain('你是她');
    }
  });

  it('语气字段缺失走默认值（不产出 NaN/undefined）', () => {
    const p = buildProactiveSystemPrompt({ name: '昔涟', tone: {} });
    expect(p).toContain('温暖度=0.2');
    expect(p).not.toContain('NaN');
  });
});
