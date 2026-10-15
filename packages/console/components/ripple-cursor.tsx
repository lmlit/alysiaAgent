'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type Ripple = { id: number; x: number; y: number; size: number }

export function RippleCursor() {
  const [ripples, setRipples] = useState<Ripple[]>([])
  const last = useRef({ x: 0, y: 0, t: 0 })
  const idRef = useRef(0)

  const spawn = useCallback((x: number, y: number, size: number) => {
    const id = idRef.current++
    setRipples((prev) => [...prev.slice(-24), { id, x, y, size }])
    window.setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== id))
    }, 1100)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.matchMedia('(pointer: coarse)').matches) return

    const onMove = (e: MouseEvent) => {
      const now = performance.now()
      const dx = e.clientX - last.current.x
      const dy = e.clientY - last.current.y
      const dist = Math.hypot(dx, dy)
      // 触发条件。★ 2026-10-03 放宽：原值 42px / 55ms 太严 ——
      //   慢慢挪鼠标完全不出涟漪，用户会以为"水波没了"，其实只是"划得不够快"。
      //   现在 26px / 42ms，随手一动就有反馈。
      if (dist < 26 || now - last.current.t < 42) return
      last.current = { x: e.clientX, y: e.clientY, t: now }
      const speed = Math.min(dist, 160)
      spawn(e.clientX, e.clientY, 20 + speed * 0.55)
    }

    const onClick = (e: MouseEvent) => spawn(e.clientX, e.clientY, 120)

    window.addEventListener('mousemove', onMove, { passive: true })
    window.addEventListener('mousedown', onClick, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mousedown', onClick)
    }
  }, [spawn])

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[9999] overflow-hidden"
    >
      {ripples.map((r) => (
        <span
          key={r.id}
          className="ripple-dot"
          style={{
            left: r.x,
            top: r.y,
            width: r.size,
            height: r.size,
          }}
        />
      ))}
      <style>{`
        .ripple-dot {
          position: absolute;
          transform: translate(-50%, -50%) scale(0.2);
          border-radius: 9999px;
          /* ★ 用主题变量，不用写死的暖金 ——
             否则切到 sakura 之后满地还是暖金色涟漪，跟她的粉紫对不上。
             2026-10-03 同时提高对比：原描边 55% 在深底上太淡，看着像没画出来。 */
          border: 1.5px solid color-mix(in oklab, var(--primary) 85%, transparent);
          background: radial-gradient(
            circle,
            color-mix(in oklab, var(--primary) 30%, transparent) 0%,
            color-mix(in oklab, var(--accent) 14%, transparent) 45%,
            transparent 70%
          );
          animation: ripple-pop 1.05s cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
          will-change: transform, opacity;
        }
        @keyframes ripple-pop {
          0% { transform: translate(-50%, -50%) scale(0.2); opacity: 0.9; }
          100% { transform: translate(-50%, -50%) scale(1.4); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .ripple-dot { animation-duration: 0.01ms; opacity: 0; }
        }
      `}</style>
    </div>
  )
}
