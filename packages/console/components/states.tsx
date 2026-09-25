import { AlertTriangle, PlugZap, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 数据状态的统一表达。约定（spec: alysia-console §5/§6）：
 *   - 每页必须有 loading 与 error 态，不得白屏
 *   - 未接入的区块用 NotWired 显式标注，**不得用 mock 冒充真数据**
 */

/** 加载骨架：沿用设计系统的 shimmer */
export function LoadingBlock({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-4 rounded-full bg-secondary/60 animate-shimmer"
          style={{
            width: `${[100, 82, 64, 90, 72][i % 5]}%`,
            backgroundImage:
              'linear-gradient(90deg, transparent, oklch(0.92 0.02 75 / 8%), transparent)',
            backgroundSize: '200% 100%',
          }}
        />
      ))}
      <span className="sr-only">加载中</span>
    </div>
  )
}

/** 错误态：可读文案 + 重试。绝不静默 —— 细节已 console.error（见 lib/api/client.ts） */
export function ErrorBlock({
  message,
  onRetry,
  className,
}: {
  message: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-2xl border border-accent/30 bg-accent/[0.07] p-5 text-sm',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground/90">没能读到数据</p>
          <p className="mt-1 break-words leading-relaxed text-muted-foreground">{message}</p>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-secondary"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            重试
          </button>
        )}
      </div>
    </div>
  )
}

/** 空态 */
export function EmptyBlock({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted-foreground',
        className,
      )}
    >
      {text}
    </div>
  )
}

/**
 * 未接入标注 —— 核心数据源还没暴露成 API 的区块。
 * 显式说明「后端还没有这个接口」，而不是塞假数据让它看起来正常。
 */
export function NotWired({
  title,
  detail,
  className,
}: {
  title: string
  detail: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-dashed border-border bg-secondary/20 p-5 text-sm',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <PlugZap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="font-medium text-foreground/70">{title} · 尚未接入</p>
          <p className="mt-1 leading-relaxed text-muted-foreground">{detail}</p>
        </div>
      </div>
    </div>
  )
}
