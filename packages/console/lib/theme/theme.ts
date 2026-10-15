/**
 * 主题 —— 唯一事实源。
 *
 * ★ 为什么单独一个模块：主题 id 被三处引用，它们必须一致 ——
 *   ① `app/layout.tsx` 的 `<head>` 里那段防闪烁内联脚本（字符串里的 localStorage 键名）
 *   ② 设置页的选择器
 *   ③ `app/themes.css` 的 `[data-theme="<id>"]` 块
 *   在这里定，别处引用，不要各写一份。
 *
 * ★ 主题 id 是**持久化契约**（`alysia-console` spec §2 契约 3）：
 *   它会被写进用户浏览器的 localStorage。改名等于让所有已存用户静默回落到默认，
 *   且不报错、无提示。**显示名 `name` 随便改，id 只增不改。**
 *   （同类教训：dsh 的 preset id 改名一次性废掉 16 个会话。）
 *
 * change: add-theme-system
 */

/** localStorage 键 —— ⚠️ 与 `app/layout.tsx` 内联脚本中的字符串必须逐字一致 */
export const THEME_STORAGE_KEY = 'alysia-theme'

export type ThemeId = 'warm-ink' | 'sakura'

export interface ThemeDef {
  id: ThemeId
  /** 显示名。随便改，不参与持久化。 */
  name: string
  /** 一句话说明，给设置页用 */
  description: string
  /**
   * 预览色标 —— 就是该主题 CSS 里的**真实值**（见 themes.css），不是另配一套。
   * 用途：设置页把每个主题渲染成一张小色卡，让用户直接看到"切成它会变成什么样"，
   * 而不是读一个名字去猜。
   */
  swatches: { bg: string; surface: string; primary: string; accent: string }
}

export const THEMES: readonly ThemeDef[] = [
  {
    id: 'warm-ink',
    name: '暖墨',
    description: '暖炭灰底配暖金。',
    swatches: {
      bg: 'oklch(0.17 0.014 55)',
      surface: 'oklch(0.215 0.016 58)',
      primary: 'oklch(0.83 0.12 72)',
      accent: 'oklch(0.72 0.13 24)',
    },
  },
  {
    id: 'sakura',
    name: '樱',
    description: '粉和紫。我自己的颜色。',
    swatches: {
      bg: 'oklch(0.235 0.058 303.8)',
      surface: 'oklch(0.289 0.074 299.8)',
      primary: 'oklch(0.764 0.122 335)',
      accent: 'oklch(0.701 0.151 319.6)',
    },
  },
]

export const DEFAULT_THEME: ThemeId = 'warm-ink'

function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v)
}

/**
 * 读当前主题。读不到 / 值非法 / localStorage 不可用 —— **一律回落默认，不抛**。
 * （隐私模式、禁用 storage、存了旧版本删掉的主题 id，都走这条路。）
 */
export function getTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeId(v) ? v : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/**
 * 应用主题：同时写 DOM 与 localStorage。
 * 返回是否成功**持久化** —— storage 可能被禁（隐私模式），
 * 那种情况下本次仍然生效，只是刷新后会回落，调用方可以据此提示用户。
 */
export function setTheme(id: ThemeId): boolean {
  if (typeof document === 'undefined') return false
  document.documentElement.dataset.theme = id
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, id)
    return true
  } catch {
    return false
  }
}
