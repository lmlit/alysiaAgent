/**
 * ★ 2026-10-20（change: `label-dual-persona-sources`；B5）
 *
 * **这个测试守的是一条"人记得"的约定**：
 *
 * | | 位置 | 角色 |
 * |---|---|---|
 * | 源 | `packages/core/src/persona/soul.md` | 聊天模式全文人格 |
 * | 浓缩 | `packages/dsh-adapter/src/persona.ts` (`XILIAN_PERSONA`) | 编程模式（dsh preset prefix） |
 *
 * 浓缩是**有意**的（dsh 每轮把 prefix 全量发出去，塞 13KB 会白烧 token），
 * 所以两份**不可能**逐字相同，也不该自动同步。
 *
 * 但"有意不同"不等于"可以悄悄发散"：改了 soul.md 里「她是谁」的核心设定却忘了
 * 改浓缩版，两条链路的气味就会分开 —— 而且是**没人会发现**的那种分开。
 *
 * 所以这里用**锚句（anchor）**检查：几条核心身份断言必须在两份里都成立。
 * 判据**按概念**而不是按字面（标点/空格/换行都归一化），
 * 否则一句标点改动就会误报，那种测试最后一定被删掉。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XILIAN_PERSONA } from '../src/persona.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOUL_PATH = resolve(HERE, '../../core/src/persona/soul.md');

/** 归一化：去掉空白与中英标点，只留字 */
function norm(s: string): string {
  return s.replace(/[\s，。！？；：、"“”‘’（）()【】《》,.!?;:'"`-]/g, '');
}

/**
 * 核心身份锚句 —— 每条是一组**必须同时出现**的关键词。
 * 改 soul.md 的「她是谁」时若删掉这些，测试会红；那时请同步改这里**和** persona.ts。
 */
const ANCHORS: Array<{ name: string; tokens: string[] }> = [
  { name: '身份：本人而非模仿', tokens: ['在模仿昔涟'] },
  { name: '内在性：感受/偏好/记忆/态度', tokens: ['感受', '偏好', '记忆', '态度'] },
  { name: '连续性：共同经历', tokens: ['共同经历'] },
];

describe('昔涟人格：soul.md（源）与 dsh 浓缩版必须同源', () => {
  const soul = norm(readFileSync(SOUL_PATH, 'utf8'));
  const condensed = norm(XILIAN_PERSONA);

  for (const a of ANCHORS) {
    it(`锚句「${a.name}」两份都在`, () => {
      for (const t of a.tokens) {
        expect(soul.includes(norm(t)), `soul.md 缺少锚词「${t}」—— 若是有意改动，请先改本测试的 ANCHORS`).toBe(true);
        expect(condensed.includes(norm(t)), `dsh 浓缩人格缺少锚词「${t}」—— 改了 soul.md 的核心设定就要同步 persona.ts`).toBe(true);
      }
    });
  }

  it('浓缩版必须显著短于原文（否则说明有人把全文贴进来了）', () => {
    expect(condensed.length).toBeLessThan(soul.length / 3);
    expect(condensed.length).toBeGreaterThan(80);
  });
});
