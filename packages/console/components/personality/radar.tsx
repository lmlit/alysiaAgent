'use client'

import { useEffect, useRef, useState } from 'react'

const SIZE = 260
const CENTER = SIZE / 2
const RADIUS = 96
const RINGS = 4

export type RadarDatum = { label: string; value: number }

function pointAt(angle: number, r: number) {
  return {
    x: CENTER + r * Math.cos(angle),
    y: CENTER + r * Math.sin(angle),
  }
}

/** 值域钳到 0..1，负值/NaN 不画出诡异的形状 */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

export function PersonalityRadar({ data }: { data: RadarDatum[] }) {
  const ref = useRef<SVGSVGElement | null>(null)
  const [t, setT] = useState(0) // 0..1 动画进度

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      io.disconnect()
      const start = performance.now()
      const dur = 1200
      const tick = (now: number) => {
        const p = Math.min((now - start) / dur, 1)
        setT(1 - Math.pow(1 - p, 3))
        if (p < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const n = data.length

  // 少于 3 个轴画不出多边形——显式说明，不画一个破图
  if (n < 3) {
    return (
      <div className="mt-4 grid h-64 w-64 place-items-center rounded-2xl border border-dashed border-border text-center text-xs text-muted-foreground">
        人格参数不足 3 项，
        <br />
        画不出雷达图
      </div>
    )
  }

  const angleFor = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2

  const dataPoints = data.map((a, i) => pointAt(angleFor(i), RADIUS * clamp01(a.value) * t))
  const dataPath = dataPoints.map((p) => `${p.x},${p.y}`).join(' ')

  return (
    <svg ref={ref} viewBox={`0 0 ${SIZE} ${SIZE}`} className="mt-4 h-64 w-64">
      {/* rings */}
      {Array.from({ length: RINGS }).map((_, r) => {
        const rr = (RADIUS * (r + 1)) / RINGS
        const pts = data
          .map((_, i) => {
            const p = pointAt(angleFor(i), rr)
            return `${p.x},${p.y}`
          })
          .join(' ')
        return (
          <polygon
            key={r}
            points={pts}
            fill="none"
            stroke="oklch(0.92 0.02 75 / 0.1)"
            strokeWidth={1}
          />
        )
      })}

      {/* spokes + labels */}
      {data.map((a, i) => {
        const outer = pointAt(angleFor(i), RADIUS)
        const label = pointAt(angleFor(i), RADIUS + 22)
        return (
          <g key={a.label}>
            <line
              x1={CENTER}
              y1={CENTER}
              x2={outer.x}
              y2={outer.y}
              stroke="oklch(0.92 0.02 75 / 0.1)"
              strokeWidth={1}
            />
            <text
              x={label.x}
              y={label.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[11px]"
            >
              {a.label}
            </text>
          </g>
        )
      })}

      {/* data area */}
      <polygon
        points={dataPath}
        fill="oklch(0.83 0.12 72 / 0.22)"
        stroke="oklch(0.83 0.12 72)"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {dataPoints.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3} fill="oklch(0.83 0.12 72)" />
      ))}
    </svg>
  )
}
