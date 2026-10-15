'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { LucideIcon } from 'lucide-react'
import {
  Code2,
  LayoutDashboard,
  MessageCircleHeart,
  Sparkles,
  Waypoints,
  Home,
  Menu,
  Settings,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useApi } from '@/lib/api/use-api'
import { lifeApi } from '@/lib/api/modules'
import { adaptLife } from '@/lib/adapt'

type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  /**
   * 外部目标（自定义协议 / 站外链接）—— 渲染成 `<a>` 而不是 Next 的 `<Link>`。
   * ★ 拿 `<Link>` 走 `dsh://` 会被当成站内路由，跳到 `/dsh://` 然后 404。
   */
  external?: boolean
}

const nav: NavItem[] = [
  { href: '/', label: '首页', icon: Home },
  { href: '/dashboard', label: '总览', icon: LayoutDashboard },
  { href: '/chat', label: '聊天', icon: MessageCircleHeart },
  // ★ 编程模式由 **dsh** 承接（Electron 桌面应用，`dsh://` 协议已在系统注册）。
  //   但这里指向站内的引导页 `/code`，**不直接跳 `dsh://`** ——
  //   自定义协议在没装 dsh 的机器上点了毫无反应，用户只会以为按钮坏了。
  //   引导页负责讲清"去哪儿、为什么、没装怎么办"，真正的 dsh:// 按钮在那一页上。
  //   人格与记忆的通道见 openspec/specs/dsh-adapter/spec.md（另一件事）。
  { href: '/code', label: '编程模式', icon: Code2 },
  { href: '/life', label: '我的生活', icon: Sparkles },
  { href: '/personality', label: '人格', icon: Waypoints },
  { href: '/settings', label: '设置', icon: Settings },
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
          // ★ 2026-10-03：不透明度 95% → 80%，模糊 xl → 2xl。
          //   95% 只透 5%，模糊几乎没有可显形的对象 ——
          //   用户反馈"毛玻璃没了"，其实是被这 5% 挡在了外面。
          'fixed inset-y-0 left-0 z-50 w-64 shrink-0 border-r border-sidebar-border bg-sidebar/80 backdrop-blur-2xl transition-transform md:static md:translate-x-0',
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
              // 外部项不参与高亮 —— 它不是一个"当前页"
              const active = !item.external && pathname === item.href
              const Icon = item.icon
              const className = cn(
                'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors',
                active
                  ? 'bg-sidebar-accent text-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
              )
              const inner = (
                <>
                  <Icon
                    className={cn(
                      'h-4 w-4 transition-colors',
                      active ? 'text-primary' : 'text-muted-foreground group-hover:text-primary',
                    )}
                  />
                  {item.label}
                </>
              )

              // ★ 外部目标必须是裸 `<a>`：Next 的 `<Link>` 会把 `dsh://` 当站内路由
              return item.external ? (
                <a
                  key={item.href}
                  href={item.href}
                  className={className}
                  onClick={() => setOpen(false)}
                >
                  {inner}
                </a>
              ) : (
                <Link
                  key={item.href}
                  href={item.href}
                  className={className}
                  onClick={() => setOpen(false)}
                >
                  {inner}
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
