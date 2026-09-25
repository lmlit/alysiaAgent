'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  ensureStarted,
  fitTo,
  getStatus,
  subscribe,
  type Live2DStatus,
} from '@/lib/live2d/shared-instance'

/**
 * Live2D 持久层 —— 挂在 root layout，**跨路由不卸载**。
 *
 * change: live2d-persist-across-pages
 *
 * 本层渲染**唯一**一块 canvas；页面里的 `<XilianFigure>` 只是注册一个"槽位"矩形，
 * 本层把 canvas **用 CSS 定位到那个矩形上面**，而不是把 canvas 搬进槽位。
 *
 * ★ 为什么不能用 appendChild 搬家（试过，会崩）：
 *   把 React 渲染出来的节点搬走，React 就丢失了对它父节点的认知，之后插入/删除兄弟节点时抛
 *   `NotFoundError: Failed to execute 'insertBefore'/'removeChild' on 'Node'`，
 *   整页白屏。Portal 换容器同理（容器是渲染时读的，不受支持）。
 *
 * ★ 所以改成"canvas 不动，位置随槽位走"：
 *   槽位矩形 → 换算成文档坐标 → `transform: translate()` + 尺寸。
 *   React 全程只认它自己那一份 DOM 结构，永远不会错位。
 *
 * 代价：需要测量槽位位置（注册时 + 尺寸变化 + 布局稳定期内轮询）。
 */

type Ctx = {
  status: Live2DStatus
  /** 槽位注册（返回注销函数）。同一时刻只认最后一个注册的槽位。 */
  registerSlot: (el: HTMLElement) => () => void
  /** 容器尺寸变化时通知 */
  requestFit: (w: number, h: number) => void
}

const Live2DCtx = createContext<Ctx | null>(null)

export function useLive2D(): Ctx | null {
  return useContext(Live2DCtx)
}

/** 布局稳定期：数据是异步到的，hero 会被撑动，这段时间内持续复测 */
const SETTLE_MS = 3000
const SETTLE_INTERVAL = 200

export function Live2DLayer({ children }: { children: ReactNode }) {
  const status = useSyncExternalStore(subscribe, getStatus, () => 'loading' as Live2DStatus)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const slotRef = useRef<HTMLElement | null>(null)
  const rafRef = useRef<number | null>(null)

  /** 把 canvas 盒子对齐到当前槽位的文档矩形 */
  const sync = useCallback(() => {
    const box = boxRef.current
    const slot = slotRef.current
    if (!box) return
    if (!slot) {
      box.style.opacity = '0'
      return
    }
    const r = slot.getBoundingClientRect()
    const w = Math.round(r.width)
    const h = Math.round(r.height)
    if (w <= 0 || h <= 0) {
      box.style.opacity = '0'
      return
    }
    // 视口矩形 → 文档坐标（absolute 在未定位祖先下即文档坐标系，随页面滚动）
    box.style.transform = `translate(${Math.round(r.left + window.scrollX)}px, ${Math.round(
      r.top + window.scrollY,
    )}px)`
    box.style.width = `${w}px`
    box.style.height = `${h}px`
    box.style.opacity = '1'
    fitTo(w, h)
  }, [])

  /** rAF 合并重复调用 */
  const scheduleSync = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      sync()
    })
  }, [sync])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    ensureStarted(canvas)
  }, [])

  // 窗口尺寸变化 → 复测
  useEffect(() => {
    window.addEventListener('resize', scheduleSync)
    return () => window.removeEventListener('resize', scheduleSync)
  }, [scheduleSync])

  const registerSlot = useCallback(
    (el: HTMLElement) => {
      slotRef.current = el
      scheduleSync()

      // 布局稳定期轮询：异步数据到达会撑动 hero，ResizeObserver 抓不到"位置变了但尺寸没变"
      const ro = new ResizeObserver(scheduleSync)
      ro.observe(el)
      if (document.body) ro.observe(document.body)

      const settle = window.setInterval(scheduleSync, SETTLE_INTERVAL)
      const stop = window.setTimeout(() => window.clearInterval(settle), SETTLE_MS)

      return () => {
        ro.disconnect()
        window.clearInterval(settle)
        window.clearTimeout(stop)
        if (slotRef.current === el) {
          slotRef.current = null
          scheduleSync()
        }
      }
    },
    [scheduleSync],
  )

  const requestFit = useCallback(
    (w: number, h: number) => {
      fitTo(w, h)
      scheduleSync()
    },
    [scheduleSync],
  )

  const ctx = useMemo<Ctx>(
    () => ({ status, registerSlot, requestFit }),
    [status, registerSlot, requestFit],
  )

  return (
    <Live2DCtx.Provider value={ctx}>
      {children}
      {/*
        canvas 盒子：本身留在 React 树里的固定位置（永不搬家），只靠 transform 贴合槽位。
        absolute + 无定位祖先 ⇒ 文档坐标系，随页面正常滚动。
      */}
      <div
        ref={boxRef}
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 0,
          height: 0,
          opacity: 0,
          // 盒子与槽位等大，开启指针事件以保留模型点击交互（9 个命中区）；
          // 尺寸为 0 / 无槽位时不会挡住任何东西
          pointerEvents: 'auto',
          transition: 'opacity 300ms',
        }}
      >
        <canvas ref={canvasRef} className="block h-full w-full" aria-label="昔涟的形象" />
      </div>
    </Live2DCtx.Provider>
  )
}
