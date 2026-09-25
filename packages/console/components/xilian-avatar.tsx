import { cn } from '@/lib/utils'

type Props = {
  size?: number
  className?: string
  /** subtle = softer glow for inline use */
  intensity?: 'soft' | 'full'
}

/**
 * Abstract, non-figurative avatar for 昔涟 — a warm breathing orb with an
 * inner "spark" and drifting light. Pure SVG/CSS, no external assets.
 */
export function XilianAvatar({ size = 160, className, intensity = 'full' }: Props) {
  return (
    <div
      className={cn('relative', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <div className="absolute inset-0 animate-breathe">
        <svg viewBox="0 0 200 200" className="h-full w-full overflow-visible">
          <defs>
            <radialGradient id="xl-core" cx="42%" cy="38%" r="70%">
              <stop offset="0%" stopColor="oklch(0.96 0.05 85)" />
              <stop offset="42%" stopColor="oklch(0.85 0.13 68)" />
              <stop offset="78%" stopColor="oklch(0.68 0.14 32)" />
              <stop offset="100%" stopColor="oklch(0.5 0.12 20)" />
            </radialGradient>
            <radialGradient id="xl-halo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="oklch(0.83 0.12 72 / 0.5)" />
              <stop offset="60%" stopColor="oklch(0.72 0.13 24 / 0.14)" />
              <stop offset="100%" stopColor="transparent" />
            </radialGradient>
            <filter id="xl-blur">
              <feGaussianBlur stdDeviation="6" />
            </filter>
          </defs>

          {intensity === 'full' && (
            <circle cx="100" cy="100" r="96" fill="url(#xl-halo)" className="animate-drift" />
          )}

          <circle cx="100" cy="100" r="62" fill="url(#xl-core)" />
          {/* soft inner light */}
          <ellipse cx="80" cy="76" rx="26" ry="20" fill="oklch(0.98 0.03 90 / 0.55)" filter="url(#xl-blur)" />
          {/* ring */}
          <circle
            cx="100"
            cy="100"
            r="74"
            fill="none"
            stroke="oklch(0.83 0.12 72 / 0.35)"
            strokeWidth="1.2"
            strokeDasharray="2 8"
            className="animate-[spin_28s_linear_infinite] origin-center"
          />
          {/* drifting spark particles */}
          <circle cx="150" cy="70" r="3" fill="oklch(0.9 0.06 85)" className="animate-float" />
          <circle cx="52" cy="140" r="2.4" fill="oklch(0.75 0.13 30)" className="animate-float [animation-delay:1.5s]" />
          <circle cx="140" cy="150" r="2" fill="oklch(0.88 0.05 80)" className="animate-float [animation-delay:3s]" />
        </svg>
      </div>
    </div>
  )
}
