/**
 * 转述槽预算的守卫（★ 2026-10-25，change: `fix-retell-budget`）
 *
 * 背景：`life.retell` 首版给了 `max_tokens: 512`（我按"输出只有一两句话"估的），
 * 生产 5 连测实测：**reasoning 吃掉 223–443 tokens**，output 已到 466 —— 顶到 512 就
 * `finish=length` + content 0 字。表现是**同一条输入时好时坏**（第一次 25 字、第二次空）。
 *
 * 这个文件守两件事：
 *   ① 槽位**必须有 `max_tokens`**（缺省 = 交给 API 默认，等于把预算交给别人）
 *   ② 值必须留得出推理余量（≥1024）—— 低于它就会出现"偶发空响应"这种最难查的故障
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_SAMPLING } from '../../src/provider/sampling';

describe('life.retell 采样槽', () => {
  it('★ 必须显式设置 max_tokens（不许留给 API 默认）', () => {
    expect(DEFAULT_SAMPLING.life.retell.max_tokens).toBeTypeOf('number');
  });

  it('★ 必须留够推理余量（≥1024）：实测 reasoning 可吃掉 443 tokens', () => {
    expect(DEFAULT_SAMPLING.life.retell.max_tokens!).toBeGreaterThanOrEqual(1024);
  });

  it('温度在"活但不失控"区间（0.6–1.0）', () => {
    const t = DEFAULT_SAMPLING.life.retell.temperature!;
    expect(t).toBeGreaterThanOrEqual(0.6);
    expect(t).toBeLessThanOrEqual(1.0);
  });
});
