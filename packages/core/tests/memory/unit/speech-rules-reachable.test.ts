/**
 * **说话规则的可达性守卫**（★ 2026-10-25，change: `make-speech-rules-reachable`）
 *
 * ## 为什么需要这个文件
 *
 * 2026-10-24 我把四段说话规则写进了 `persona/talk_system.md`，然后"验证"了 DB 里的
 * `persona.system_prompt` 含这些文字，就认为上线了。
 *
 * **错在层。** `system_prompt` 按 `\n---\n` 切成 42 节，而聊天只取
 * `getCompactPersonaPrompt()` 的**前 4 节**（soul + identity + worldview）；
 * `talk_system.md` 从**第 8 节**才开始 ⇒ 那些规则**一个字都没进过聊天 prompt**。
 *
 * 所以这个文件守的不是"文案好不好"，而是**它到底到不到模型面前**：
 *   1. 生效的规则必须在 `CHAT_BREVITY_DIRECTIVE`（`required` 块）里
 *   2. `talk_system.md` 必须**自报**"我不进 prompt"，否则下一个人会再写一遍
 *   3. 量化边界：compact persona 只含前 N 节 —— 这个数字变了，说明注入面变了
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHAT_BREVITY_DIRECTIVE } from '../../../src/prompts/chat';

const TALK_MD = readFileSync(resolve(__dirname, '../../../src/persona/talk_system.md'), 'utf-8');

describe('生效的说话规则（代码侧，改动即生效）', () => {
  it('★ 四件"人手感"必须都在 CHAT_BREVITY_DIRECTIVE 里', () => {
    expect(CHAT_BREVITY_DIRECTIVE).toContain('【说话的手感】');
    expect(CHAT_BREVITY_DIRECTIVE, '开口先有反应').toContain('开口可以先有反应');
    expect(CHAT_BREVITY_DIRECTIVE, '具体化').toContain('说具体的东西');
    expect(CHAT_BREVITY_DIRECTIVE, '素材来源').toContain('【我的近期日常】');
    expect(CHAT_BREVITY_DIRECTIVE, '没有素材不许编').toContain('没有素材就不要编');
    expect(CHAT_BREVITY_DIRECTIVE, '允许不完整').toContain('允许不完整');
  });

  it('★ 配额规则在（语气词 / ♪ / 反问 合计最多一处）', () => {
    expect(CHAT_BREVITY_DIRECTIVE).toMatch(/合计最多一处/);
    expect(CHAT_BREVITY_DIRECTIVE).toContain('♪');
  });

  it('长度约束没被挤掉（默认 ≤3 句仍是第一句）', () => {
    expect(CHAT_BREVITY_DIRECTIVE).toContain('默认不超过 3 句');
    expect(CHAT_BREVITY_DIRECTIVE.split('\n')[0]).toContain('说话的分寸');
  });

  it('块不会太长（它是 required，越长越挤 optional 块）', () => {
    // 实测：+说话的手感 ≈ +350 字；上限设 900 字，防止有人往里无限加规则
    expect(CHAT_BREVITY_DIRECTIVE.length).toBeLessThan(900);
  });
});

describe('md 侧必须自报"不进 prompt"', () => {
  it('★ talk_system.md 开头必须写明它不进聊天 prompt（防下一个人再写一遍）', () => {
    const head = TALK_MD.slice(0, 900);
    expect(head).toMatch(/不进聊天 prompt/);
    expect(head, '要点名真正的生效位置').toContain('prompts/chat.ts');
    expect(head, '要给出具体节数证据，否则说服力不够').toMatch(/前 4 节|第 8 节/);
  });
});

describe('compact persona 的注入边界（数字变了 = 注入面变了）', () => {
  it('★ 默认只取前 4 节 —— 这个默认值是"哪些人格文件生效"的事实来源', () => {
    // 只读源码断言默认值，不构造 MemoryManager（这里不需要 DB）
    const src = readFileSync(resolve(__dirname, '../../../src/memory/MemoryManager.ts'), 'utf-8');
    expect(src).toMatch(/getCompactPersonaPrompt\(sections: number = 4\)/);
  });
});
