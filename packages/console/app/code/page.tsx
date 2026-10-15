import { AppShell } from '@/components/app-shell'
import { CodeEntry } from '@/components/code-entry'

/**
 * 编程模式入口页（change: code-mode-entry）。
 *
 * 与 `/life` 同构：本文件是 server component 的 thin wrapper，
 * 真正的交互在 `CodeEntry`（'use client'）。
 */
export default function CodePage() {
  return (
    <AppShell>
      <CodeEntry />
    </AppShell>
  )
}
