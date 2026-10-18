/**
 * 归属渲染单测（★ change: `attribute-engine-receipts`）。
 *
 * 起因：三处渲染器都写成「不是 user 就当成她」，于是执行端回执在 prompt 里变成
 *
 *     [23:41] 昔涟: （委托任务回执）项目 alysia-blog 第 1 轮已结束…
 *
 * —— 等于**替她写了一段她没说过的话**。用户的原话是：「她以为是我命令输出的」。
 *
 * 这个文件钉三件事：
 *   1. 三种说话人（用户 / 她 / 工程端）各有自己的标签；
 *   2. **未知 role 仍当作她**（历史数据兼容，不能因为加了个新角色就把老数据渲染成别人）；
 *   3. 标签可覆写（llm-agent 用「伙伴」而不是「你」）。
 */
import { describe, it, expect } from 'vitest';
import { dialogueSpeaker, ENGINE_SPEAKER } from '../src/memory/render-dialogue.js';

describe('说话人标签', () => {
  it('用户 → 你', () => {
    expect(dialogueSpeaker('user')).toBe('你');
  });

  it('她自己 → 昔涟', () => {
    expect(dialogueSpeaker('assistant')).toBe('昔涟');
  });

  it('★ 执行端 → 工程端（不是她，也不是用户）', () => {
    expect(dialogueSpeaker('engine')).toBe(ENGINE_SPEAKER);
    expect(ENGINE_SPEAKER).not.toBe('昔涟');
    expect(ENGINE_SPEAKER).not.toBe('你');
  });

  it('★★ 未知 role 仍当作她（历史数据兼容）', () => {
    for (const r of ['system', 'tool', 'whatever', undefined, null, 123]) {
      expect(dialogueSpeaker(r), `role=${String(r)}`).toBe('昔涟');
    }
  });

  it('标签可覆写（llm-agent 用「伙伴」）', () => {
    expect(dialogueSpeaker('user', { user: '伙伴' })).toBe('伙伴');
    expect(dialogueSpeaker('engine', { engine: '系统' })).toBe('系统');
    expect(dialogueSpeaker('assistant', { assistant: '她' })).toBe('她');
  });
});
