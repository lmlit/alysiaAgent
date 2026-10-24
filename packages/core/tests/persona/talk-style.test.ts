/**
 * 说话方式的守卫（★ 2026-10-24，change: `make-her-talk-like-a-person`）
 *
 * 这份测试守的不是"她的文案写得好不好"（那个只能靠真人听），而是**规则之间不能自己打架**：
 *
 * 1. **样本必须符合它自己的格式规则** —— 说话样本里若出现 `*动作*`、`（动作）`、markdown 标记，
 *    模型会**模仿违规样本**（示例的作用远大于禁令）。这一条最容易在后续编辑里被破坏。
 * 2. **配额规则在位** —— 「语气词 / ♪ / 反问 一条回复最多一处」是治"假"的关键，
 *    少了它就是"每条都撒娇"。
 * 3. **正面样本成规模** —— 这份文件曾经几乎全是「不要…」，正例只有半句短句；
 *    没有像样的对话样本，她就只能照着禁令写出"正确但没味"的话。
 * 4. **长度规则仍与代码常量一致**（md 与 `CHAT_BREVITY_DIRECTIVE` 两处都要在）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = resolve(__dirname, '../../src/persona/talk_system.md');
const raw = readFileSync(FILE, 'utf-8');

/** 取「说话样本」小节正文（到下一个 `---` 或 `##` 为止） */
function sampleSection(): string {
  const start = raw.indexOf('## 说话样本');
  expect(start, '说话样本小节不见了').toBeGreaterThan(-1);
  const rest = raw.slice(start);
  const end = rest.slice(1).search(/\n---\n|\n## /);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe('talk_system.md —— 说话方式守卫', () => {
  it('★ 样本本身不许违反输出格式（无动作描写、无 markdown 修饰）', () => {
    const sec = sampleSection();
    const lines = sec.split('\n').filter(l => l.trim().startsWith('- '));
    expect(lines.length, '样本太少（<8 条）就起不到"给颗粒度"的作用').toBeGreaterThanOrEqual(8);

    for (const line of lines) {
      const body = line.trim().slice(2);
      // 星号动作 / 括号动作 —— 文件自己明令禁止输出这两种
      expect(body, `样本里有星号动作：${body}`).not.toMatch(/\*[^*]+\*/);
      expect(body, `样本里有括号动作：${body}`).not.toMatch(/（[^）]*）|\([^)]*\)/);
      expect(body, `样本里用了 markdown 标记：${body}`).not.toMatch(/^[#>`]|\*\*/);
      // 样本必须是"她第一人称能直接说出口的话"，不该长到像段落
      expect(body.length, `样本过长（像段落不像消息）：${body}`).toBeLessThanOrEqual(40);
    }
  });

  it('★ 配额规则在位：语气词 / ♪ / 反问，一条回复最多一处', () => {
    expect(raw).toContain('语气词是调味料，不是主食');
    expect(raw).toContain('总共最多出现一处');
    expect(raw).toContain('♪');
  });

  it('★ 四段补强都在：开口先有反应 / 具体化 / 她有自己的事 / 允许不完整', () => {
    for (const heading of ['## 开口先有反应', '## 具体，永远比抽象好听', '## 她有自己的事', '## 允许不完整']) {
      expect(raw, `缺小节：${heading}`).toContain(heading);
    }
  });

  it('★ 规则必须**指名素材来源**（否则"可以带一句自己的事"是空话）', () => {
    // 2026-10-25（生活联动）：素材是【我的近期日常】/【此刻的你】，规则里必须点出来
    expect(raw).toContain('【我的近期日常】');
    expect(raw).toContain('【此刻的你】');
    expect(raw, '要禁止把素材当清单复述').toContain('不是汇报');
    expect(raw, '没有素材时不许编').toContain('不要编');
  });

  it('长度规则与代码常量一致（md 与 CHAT_BREVITY_DIRECTIVE 两处都要在）', () => {
    expect(raw).toContain('默认不超过 3 句');
    expect(raw, '要保留"两处都要改"的提醒，否则下次只改一处').toContain('CHAT_BREVITY_DIRECTIVE');
  });

  it('样本里不许出现"作为 AI / 我理解你的感受"这类客服话术', () => {
    const sec = sampleSection();
    for (const bad of ['作为 AI', '作为语言模型', '我理解你的感受', '我会尽力帮助你']) {
      expect(sec).not.toContain(bad);
    }
  });
});
