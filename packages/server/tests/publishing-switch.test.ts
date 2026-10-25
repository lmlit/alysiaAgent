/**
 * 发布能力总开关（★ 2026-10-25，change: `disable-publishing`）
 *
 * 用户要求先停掉「昔涟自己生成网站、发博客」这条链路（要先想清楚怎么改再开）。
 * 这个文件守**默认关**这件事 —— 默认值是最容易被"顺手改成 true"的东西，
 * 而它一改，她就会重新拿到委托工具并可能自己发东西出去。
 *
 * ⚠️ 与「公开日记」不是一回事：日记是**内容**（`ai_life_records` 里 `visibility='shared'`），
 * 这里是**投递机制**（工具 + 项目 + runner）。关投放不等于停写日记。
 */
import { describe, it, expect } from 'vitest';
import { publishingEnabled } from '../src/modules/core.js';

describe('publishingEnabled —— 页面/博客发布总开关', () => {
  it('★ 缺省（配置里没有 features.publish）⇒ **关闭**', () => {
    expect(publishingEnabled({})).toBe(false);
    expect(publishingEnabled({ features: {} })).toBe(false);
    expect(publishingEnabled({ features: { codeMode: false } })).toBe(false);
  });

  it('★ 只有**显式 true** 才开（不许被 truthy 值蒙混）', () => {
    expect(publishingEnabled({ features: { publish: true } })).toBe(true);
    // @ts-expect-error 故意传非布尔：默认关闭的策略要求严格判等
    expect(publishingEnabled({ features: { publish: 'true' } })).toBe(false);
    // @ts-expect-error 同上
    expect(publishingEnabled({ features: { publish: 1 } })).toBe(false);
  });
});
