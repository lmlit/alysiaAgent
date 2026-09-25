'use client'

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { XilianAvatar } from '@/components/xilian-avatar'
import { useLive2D } from '@/components/live2d/live2d-layer'

/**
 * 昔涟的**大尺寸形象** —— Live2D 优先，暖光球兜底。
 *
 * 分工（change: migrate-live2d-to-console 决策 A）：
 *   - **小尺寸**（消息气泡 34 / 顶栏 44 / 侧栏 36 / CTA 120）→ 一律 `XilianAvatar`（SVG 暖光球）
 *     给 34px 的位置塞 3D 模型是荒谬的
 *   - **大尺寸 hero** → 本组件
 *
 * ★ 本组件**不持有 canvas**（change: live2d-persist-across-pages）：
 *   Live2D 实例在 `Live2DLayer`（root layout）里跨路由存活，本组件只做两件事——
 *   ① 注册一个"槽位"，让 layer 把共享 canvas portal 进来
 *   ② 容器尺寸变化时通知 layer 重算缩放
 *   这样换页面**不会重载 9MB 模型**（原先每次换页都要重建，约 500ms + 一次暖光球闪现）。
 */
const RATIO = 0.88

export function XilianFigure({
  height = 260,
  className,
  avatarClassName,
}: {
  /** 显示高度（宽按人像比例算） */
  height?: number
  className?: string
  /** 兜底暖光球的额外类名 */
  avatarClassName?: string
}) {
  const live2d = useLive2D()
  const slotRef = useRef<HTMLDivElement | null>(null)

  const width = Math.round(height * RATIO)
  const status = live2d?.status ?? 'fallback'

  // ★ 依赖取**稳定的函数引用**，不要依赖整个 ctx 对象 ——
  //   否则只要 layer 因任何原因重渲染，这里就会重注册，进而触发 layer 的 state 更新
  const registerSlot = live2d?.registerSlot
  const requestFit = live2d?.requestFit

  // 注册槽位（挂载一次；尺寸变化走下面那条）
  useEffect(() => {
    const el = slotRef.current
    if (!el || !registerSlot) return
    return registerSlot(el)
  }, [registerSlot])

  // 尺寸变化 → 让共享实例适配新盒子（重算缩放，不重载模型）
  useEffect(() => {
    requestFit?.(width, height)
  }, [requestFit, width, height])

  // Live2D 真的失败时，暖光球是**兜底形象**（不是占位符）——这时必须显示它
  if (status === 'fallback') {
    return (
      <div
        data-live2d="fallback"
        className={cn('grid place-items-center', className)}
        style={{ width, height }}
      >
        <XilianAvatar size={Math.min(width, height)} className={avatarClassName} />
      </div>
    )
  }

  return (
    <div
      // 可观测：Live2D 是静默退化，不标出来分不清"没加载"和"坏了"
      data-live2d={status}
      className={cn('relative grid place-items-center', className)}
      // 尺寸照旧占住 → 模型出现时**不引起布局跳动**
      style={{ width, height }}
    >
      {/*
        槽位：只是给 Live2DLayer **测量**用的矩形，canvas 不放在这里（canvas 留在层里，
        靠 transform 覆盖到这个矩形上 —— 把它搬进来会让 React 丢掉父节点认知而崩）。

        ★ 加载期**不放暖光球占位**（2026-09-25 用户决定去掉）：
          球和昔涟是两个完全不同的形状，先摆球再换成她，看起来像"被换掉了"而不是"加载好了"。
          占位符应当是同一个东西的粗糙版，而不是另一个东西。加载期就留空，靠固定尺寸防跳动。
      */}
      <div ref={slotRef} className="relative h-full w-full" />
    </div>
  )
}
