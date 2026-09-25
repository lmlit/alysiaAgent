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
      // Throttle: only ripple after enough travel and a small time gap
      if (dist < 42 || now - last.current.t < 55) return
      last.current = { x: e.clientX, y: e.clientY, t: now }
      const speed = Math.min(dist, 160)
      spawn(e.clientX, e.clientY, 18 + speed * 0.5)
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
          border: 1.5px solid oklch(0.83 0.12 72 / 0.55);
          background: radial-gradient(
            circle,
            oklch(0.83 0.12 72 / 0.18) 0%,
            oklch(0.72 0.13 24 / 0.06) 45%,
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
