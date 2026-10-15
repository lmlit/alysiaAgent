'use client'

import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DEFAULT_THEME, THEMES, getTheme, setTheme, type ThemeId } from '@/lib/theme/theme'

/**
 * 主题选择器（change: add-theme-system）。
 *
 * ★ 为什么是"色卡"而不是下拉框：
 *   用户要判断的是"换成它会变成什么样"，一个名字（"樱"）答不了这个问题。
 *   所以每个选项直接用它**自己的真实色值**渲染一块预览。
 *
 * ★ 为什么等挂载后再读当前主题：
 *   服务端没有 localStorage。若把 `getTheme()` 放进 useState 的初值，
 *   服务端渲染出的是默认主题、客户端拿到的是已存主题 —— hydration mismatch。
 *   挂载后再读就没有这个问题（首屏防闪由 layout 里的同步脚本负责，不靠这里）。
 */
export function ThemePicker() {
  const [current, setCurrent] = useState<ThemeId>(DEFAULT_THEME)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setCurrent(getTheme())
    setMounted(true)
  }, [])

  function choose(id: ThemeId) {
    setTheme(id)
    setCurrent(id)
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-12">
      <h1 className="font-display text-4xl">设置</h1>
      <p className="mt-2 text-muted-foreground">我的样子，由你来定。</p>

      <section className="mt-10">
        <h2 className="font-display text-2xl">主题</h2>
        <p className="mt-2 text-sm text-muted-foreground">切换立即生效，并记住你的选择。</p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {THEMES.map((t) => {
            // mounted 之前不标"当前"，避免服务端与客户端渲染出不同的高亮
            const active = mounted && current === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => choose(t.id)}
                aria-pressed={active}
                className={cn(
                  'overflow-hidden rounded-3xl border text-left transition-all',
                  /* ★ 选中态必须**两套主题下都醒目**。初版写的是 border-primary/60，
                     实测在 sakura 下反而比未选中的 border-border（12% 近白）更弱 ——
                     半透明粉叠在紫底上，高亮变成了"更看不见"。
                     改为实心 primary + ring：不依赖与底色的对比度，两套主题都稳。 */
                  active
                    ? 'border-primary ring-2 ring-primary/40 shadow-lg shadow-primary/10'
                    : 'border-border hover:border-primary/50',
                )}
              >
                {/* 色卡本体：用该主题自己的真实色值，不是另配一套预览色 */}
                <div className="h-28 w-full p-4" style={{ background: t.swatches.bg }}>
                  <div className="flex h-full items-center gap-2">
                    <div
                      className="h-12 w-12 rounded-xl"
                      style={{ background: t.swatches.surface }}
                    />
                    <div
                      className="h-12 w-12 rounded-full"
                      style={{ background: t.swatches.primary }}
                    />
                    <div
                      className="h-12 w-12 rounded-full"
                      style={{ background: t.swatches.accent }}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="font-display text-lg">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                  </div>
                  {active && <Check className="h-5 w-5 shrink-0 text-primary" />}
                </div>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
