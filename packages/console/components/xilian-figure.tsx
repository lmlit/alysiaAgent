'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { useApi } from '@/lib/api/use-api'
import { stickerApi } from '@/lib/api/modules'

/**
 * 昔涟的**大尺寸形象** —— 表情包轮换。
 *
 * ★ 为什么不再用 Live2D（轻月 2026-10-03）：
 *   9MB 模型、加载期空白、跨页持久化的复杂度，换来的只是"会呼吸"；
 *   而手边这套表情包本来就是她的脸，还带情绪和台词。
 *   形象应该让人**一眼认出是她**，而不是让人**等它加载完**。
 *
 * ★ Live2D 的代码**原样保留**（`lib/live2d/`、`components/live2d/` 都没动），
 *   只是 root layout 不再挂载 `Live2DLayer` —— 想回去，改一行即可。
 *
 * 尺寸分工不变（change: migrate-live2d-to-console 决策 A）：
 *   - 小尺寸（气泡 34 / 顶栏 44 / 侧栏 36 / CTA 120）→ `XilianAvatar`（SVG 暖光球）
 *   - 大尺寸 → 本组件
 *
 * change: sticker-figure
 */

/** 轮换间隔。太快像闪烁，太慢就成了一张静态图。 */
const ROTATE_MS = 7000
/** 交叉淡入时长（与 globals.css 的动效节奏对齐） */
const FADE_MS = 500

export function XilianFigure({
  height = 260,
  className,
}: {
  /** 边长 —— 表情包是正方形 */
  height?: number
  className?: string
}) {
  const { data } = useApi(() => stickerApi.list())
  const stickers = data?.stickers ?? []

  const [current, setCurrent] = useState<string | null>(null)
  const [shown, setShown] = useState(false)

  // 拿到列表立刻定下第一张 —— 不要等第一次定时器，否则白等一个间隔
  useEffect(() => {
    if (!current && stickers.length) setCurrent(stickers[0].name)
  }, [stickers, current])

  // 轮换：每次随机挑一张**和当前不同的**（只有一张时不轮换）
  useEffect(() => {
    if (stickers.length < 2) return
    const id = setInterval(() => {
      setCurrent((prev) => {
        const pool = stickers.filter((s) => s.name !== prev)
        return pool[Math.floor(Math.random() * pool.length)]?.name ?? prev
      })
    }, ROTATE_MS)
    return () => clearInterval(id)
  }, [stickers])

  // 尊重 prefers-reduced-motion：照常轮换，但不做淡入（不闪）
  const [reduceMotion, setReduceMotion] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduceMotion(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // 换图后先透明、下一帧再显现 —— 否则新图是"啪"地跳出来
  useEffect(() => {
    if (!current) return
    if (reduceMotion) {
      setShown(true)
      return
    }
    setShown(false)
    const t = setTimeout(() => setShown(true), 20)
    return () => clearTimeout(t)
  }, [current, reduceMotion])

  return (
    <div
      // 可观测：不标出来，分不清"图还没到"和"本来就没有图"
      data-sticker={current ?? 'loading'}
      className={cn('relative grid place-items-center', className)}
      // 固定边长占住位置 → 换图不引起布局跳动
      style={{ width: height, height }}
    >
      {/*
        加载期**什么都不显示**，沿用 2026-09-25 的决定：
        占位符应当是同一个东西的粗糙版，而不是另一个东西（当初是拿暖光球顶 Live2D，很像"被换掉了"）。
        这里靠固定尺寸防跳动。

        ⚠️ 只给当前这张发请求（不预载 65 张，那是 8MB）——
           轮换变慢时再考虑预取下一张。
      */}
      {current && (
        // eslint-disable-next-line @next/next/no-img-element -- 走 /api 直链，Next 的图片优化在这里用不上
        <img
          src={stickerApi.fileUrl(current)}
          alt="昔涟"
          width={height}
          height={height}
          className="h-full w-full object-contain transition-opacity"
          style={{ opacity: shown ? 1 : 0, transitionDuration: `${FADE_MS}ms` }}
        />
      )}
    </div>
  )
}
