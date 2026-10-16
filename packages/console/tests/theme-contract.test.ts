// tests/theme-contract.test.ts
// ★ 2026-10-16 · 计划「§四 保留新增前端功能的基本验证」的一部分：**主题切换**
//
// 这几条不是"再测一遍实现"，而是把 spec 里**跨文件的一致性契约**变成会红的断言。
// 主题 id 被**三处**引用，任何一处漂移都是静默失效：
//   ① `lib/theme/theme.ts`（THEME_STORAGE_KEY / THEMES）
//   ② `app/layout.tsx` 的防闪烁内联脚本（**字符串里的键名**）
//   ③ `app/themes.css` 的 `[data-theme="<id>"]` 块
// 「加了新主题但忘了写 CSS」= 用户切过去**什么都没变**；「改了 localStorage 键」=
// 所有已存用户的主题**静默回落到默认**（spec §2 契约 3 点名过这类事故）。
// 光看代码看不出来 —— 所以要读文件对。
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  THEMES,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  getTheme,
  setTheme,
  type ThemeId,
} from '../lib/theme/theme';

const CONSOLE_ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(CONSOLE_ROOT, rel), 'utf-8');

describe('主题数据契约（spec §2 契约 2 / 4）', () => {
  it('主题 id 唯一', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('★ 每套主题都恰好一个 primary + 一个 accent（契约 2：不许两套主色）', () => {
    for (const t of THEMES) {
      const css = read('app/themes.css');
      const block = css.split(`[data-theme='${t.id}']`)[1] ?? '';
      const body = block.split('}')[0] ?? '';
      expect(body.match(/^\s*--primary:/gm) ?? [], `${t.id} 的 --primary 不是恰好一个`).toHaveLength(1);
      expect(body.match(/^\s*--accent:/gm) ?? [], `${t.id} 的 --accent 不是恰好一个`).toHaveLength(1);
    }
  });

  it('★ 默认主题是 warm-ink，且它真的在列表里（契约 4）', () => {
    expect(DEFAULT_THEME).toBe('warm-ink');
    expect(THEMES.some((t) => t.id === DEFAULT_THEME)).toBe(true);
  });

  it('★ 每套主题都给了四个预览色标（设置页的色卡靠它，不许空）', () => {
    for (const t of THEMES) {
      for (const k of ['bg', 'surface', 'primary', 'accent'] as const) {
        expect(t.swatches[k], `${t.id}.${k} 为空`).toBeTruthy();
      }
    }
  });
});

describe('★ 跨文件一致性（三处引用必须同步）', () => {
  it('★★ `layout.tsx` 的内联脚本必须用**同一个** localStorage 键', () => {
    const layout = read('app/layout.tsx');
    expect(
      layout.includes(`localStorage.getItem('${THEME_STORAGE_KEY}')`),
      `内联脚本里的键与 theme.ts 的 THEME_STORAGE_KEY（${THEME_STORAGE_KEY}）不一致 —— ` +
        '防闪烁脚本会读不到值，切主题后刷新会闪',
    ).toBe(true);
  });

  it('★★ 每套主题 id 在 `themes.css` 里都必须有对应的 `[data-theme]` 块', () => {
    const css = read('app/themes.css');
    for (const t of THEMES) {
      expect(
        css.includes(`[data-theme='${t.id}']`) || css.includes(`[data-theme="${t.id}"]`),
        `主题 ${t.id} 没有 CSS 块 —— 用户切过去会**什么都没变**（静默失效）`,
      ).toBe(true);
    }
  });

  it('★ 预览色标是**真实值**：swatches 里的 primary/accent 必须出现在 CSS 里', () => {
    const css = read('app/themes.css');
    for (const t of THEMES) {
      expect(css, `${t.id} 的预览 primary 与 CSS 不一致（色卡会骗人）`).toContain(t.swatches.primary);
      expect(css, `${t.id} 的预览 accent 与 CSS 不一致（色卡会骗人）`).toContain(t.swatches.accent);
    }
  });
});

// ── getTheme / setTheme：读不到就回落，不抛（spec §2 契约 5 的前提）──

type FakeStorage = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };

function stubEnv(opts: { stored?: string | null; throwOn?: 'get' | 'set' } = {}) {
  const html: Record<string, string> = {};
  const store: FakeStorage = {
    getItem: () => {
      if (opts.throwOn === 'get') throw new Error('storage disabled');
      return opts.stored ?? null;
    },
    setItem: () => {
      if (opts.throwOn === 'set') throw new Error('storage disabled');
    },
  };
  (globalThis as any).window = { localStorage: store };
  (globalThis as any).document = { documentElement: { dataset: html } };
  return { html };
}

describe('getTheme / setTheme（隐私模式与非法值都不能抛）', () => {
  afterEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });

  it('★ 存了合法值 → 读回来', () => {
    stubEnv({ stored: 'sakura' });
    expect(getTheme()).toBe('sakura');
  });

  it.each([
    ['没有值', null],
    ['存了已删除的旧主题 id', 'no-such-theme'],
    ['存了非字符串语义的东西', '12345'],
  ])('★ %s → 回落默认（不抛）', (_label, stored) => {
    stubEnv({ stored });
    expect(getTheme()).toBe(DEFAULT_THEME);
  });

  it('★ localStorage 抛错（隐私模式）→ 回落默认，不抛', () => {
    stubEnv({ throwOn: 'get' });
    expect(() => getTheme()).not.toThrow();
    expect(getTheme()).toBe(DEFAULT_THEME);
  });

  it('★ setTheme 同时写 DOM 与 storage，返回 true', () => {
    const { html } = stubEnv();
    expect(setTheme('sakura')).toBe(true);
    expect(html.theme).toBe('sakura');
  });

  it('★★ storage 被禁时：**DOM 照常生效**，但返回 false（调用方据此提示"刷新后会回落"）', () => {
    const { html } = stubEnv({ throwOn: 'set' });
    expect(setTheme('sakura')).toBe(false);
    expect(html.theme, 'storage 不可用不该连当次生效都做不到').toBe('sakura');
  });

  it('★ 服务端渲染（没有 window/document）→ 返回默认，不抛', () => {
    expect(getTheme()).toBe(DEFAULT_THEME);
    expect(setTheme('sakura')).toBe(false);
  });
});

// ── 贴纸 URL：名字里可能有空格/斜杠，必须编码 ──

describe('★ 贴纸 URL 编码（表情包渲染与 hero 轮换共用）', () => {
  it('名字里的空格与斜杠必须编码（否则路径会被拆成两段）', async () => {
    const { stickerApi } = await import('../lib/api/modules');
    expect(stickerApi.fileUrl('a b/c')).toBe('/api/stickers/file/a%20b%2Fc');
  });

  it('中文名字原样编码可用', async () => {
    const { stickerApi } = await import('../lib/api/modules');
    expect(stickerApi.fileUrl('开心')).toBe('/api/stickers/file/%E5%BC%80%E5%BF%83');
  });
});
