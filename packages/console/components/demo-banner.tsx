import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 演示数据横幅 —— 页面上还有 mock 内容时必须显式告知。
 * spec: alysia-console §6「未接入的页面/区块必须在界面上显式标注，不得用 mock 冒充真数据」。
 */
export function DemoBanner({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 border-b border-accent/25 bg-accent/[0.08] px-4 py-2.5 text-xs text-foreground/80',
        className,
      )}
    >
      <Info className="mt-px h-3.5 w-3.5 shrink-0 text-accent" />
      <p className="leading-relaxed">{text}</p>
    </div>
  )
}
