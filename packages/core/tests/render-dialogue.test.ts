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
 *   1. 三种说话人（用户 / 她 / **执行记录**）各有自己的标签；
 *   2. **未知 role 仍当作她**（历史数据兼容，不能因为加了个新角色就把老数据渲染成别人）；
 *   3. 标签可覆写（llm-agent 用「伙伴」而不是「你」）。
 *
 * ★ 2026-10-18（change: `unify-her-voice-across-engineering`）：
 *   用户又说「**其实工程也是她自己**」⇒ `engine` 的默认标签改成「我（工程环境）」。
 *   归因不变（仍不是她的聊天发言），只是不再把她自己说成第三方。
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

  it('★ 执行记录 → 我（工程环境）：是她，但不是她的聊天发言', () => {
    // ★ 2026-10-18（change: `unify-her-voice-across-engineering`）：
    //   用户原话「其实工程也是她自己」⇒ 标签从「工程端」（像另一个人）改成第一人称。
    //   但归因仍是 engine —— 那段技术输出不是她在聊天里说的话。
    expect(dialogueSpeaker('engine')).toBe(ENGINE_SPEAKER);
    expect(ENGINE_SPEAKER).not.toBe('昔涟');
    expect(ENGINE_SPEAKER).not.toBe('你');
    expect(ENGINE_SPEAKER, '标签要说明"是我自己"').toContain('我');
    expect(ENGINE_SPEAKER, '不再把她自己说成第三方').not.toBe('工程端');
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
