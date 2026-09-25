'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  MessageCircleHeart,
  Sparkles,
  Waypoints,
  Home,
  Menu,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useApi } from '@/lib/api/use-api'
import { lifeApi } from '@/lib/api/modules'
import { adaptLife } from '@/lib/adapt'

const nav = [
  { href: '/', label: '首页', icon: Home },
  { href: '/dashboard', label: '总览', icon: LayoutDashboard },
  { href: '/chat', label: '聊天', icon: MessageCircleHeart },
  { href: '/life', label: '她的生活', icon: Sparkles },
  { href: '/personality', label: '人格', icon: Waypoints },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  // 侧栏的「她此刻在做什么」走真实生活快照（/api/life）
  const life = useApi(() => lifeApi.get())
  const snapshot = adaptLife(life.data?.snapshot)

  return (
    <div className="min-h-svh md:flex">
      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 shrink-0 border-r border-sidebar-border bg-sidebar/95 backdrop-blur-xl transition-transform md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-full flex-col p-5">
          <Link href="/" className="flex items-center gap-3" onClick={() => setOpen(false)}>
            <div className="relative h-9 w-9 overflow-hidden rounded-full bg-gradient-to-br from-primary to-accent" />
            <div className="leading-tight">
              <p className="font-display text-lg text-foreground">昔涟</p>
              <p className="text-[11px] text-muted-foreground">Xilian</p>
            </div>
          </Link>

          <nav className="mt-8 flex flex-1 flex-col gap-1">
            {nav.map((item) => {
              const active = pathname === item.href
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={cn(
                    'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors',
                    active
                      ? 'bg-sidebar-accent text-foreground'
                      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                  )}
                >
                  <Icon
                    className={cn(
                      'h-4 w-4 transition-colors',
                      active ? 'text-primary' : 'text-muted-foreground group-hover:text-primary',
                    )}
                  />
                  {item.label}
                </Link>
              )
            })}
          </nav>

          <div className="rounded-2xl border border-sidebar-border bg-card/60 p-4">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                {(life.loading || (!life.error && snapshot)) && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-chart-5 opacity-70" />
                )}
                <span
                  className={cn(
                    'relative inline-flex h-2 w-2 rounded-full',
                    life.error ? 'bg-muted-foreground/50' : 'bg-chart-5',
                  )}
                />
              </span>
              <p className="text-xs text-muted-foreground">
                {life.loading
                  ? '读取中…'
                  : life.error
                    ? '连不上服务端'
                    : `在线${snapshot?.mood ? ` · ${snapshot.mood}` : ''}`}
              </p>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-foreground/80">
              {life.loading
                ? '…'
                : life.error
                  ? '（她的近况暂时读不到）'
                  : snapshot?.currentActivity || '（暂无近况）'}
            </p>
          </div>
        </div>
      </aside>

      {open && (
        <button
          aria-label="关闭菜单"
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/70 px-4 py-3 backdrop-blur-xl md:hidden">
          <button
            aria-label="打开菜单"
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg p-2 hover:bg-secondary"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <span className="font-display text-lg">昔涟</span>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}
