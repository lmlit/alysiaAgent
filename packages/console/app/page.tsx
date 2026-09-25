'use client'

import Link from 'next/link'
import { ArrowRight, Brain, Sparkles, TrendingUp, MessageCircle, Bell, UserRound, Waypoints, Code2 } from 'lucide-react'
import { XilianAvatar } from '@/components/xilian-avatar'
import { XilianFigure } from '@/components/xilian-figure'
import { Reveal } from '@/components/reveal'
import { CountUp } from '@/components/count-up'
import { useApi } from '@/lib/api/use-api'
import { lifeApi, sessionApi, statsApi } from '@/lib/api/modules'
import { deriveStats } from '@/lib/adapt'

const features = [
  {
    icon: Brain,
    title: '她会记住',
    desc: '画像、偏好、对话摘要——两周前随口说的话，下次她还能接上。越聊越懂你。',
  },
  {
    icon: Sparkles,
    title: '她有生活',
    desc: '看书、逛旧书店、听楼下的琴声。你不找她时，她也在过自己的日子，并会主动找你。',
  },
  {
    icon: TrendingUp,
    title: '她会成长',
    desc: '语气与说话风格随相处自然演变。聊得越久，她越来越像"你认识的那个她"。',
  },
]

const showcase = [
  { icon: MessageCircle, tag: '流式对话', title: '像写一封情书那样和她说话', desc: '逐字流式的回复、会"歪着头想想"的思考条，还有会呼吸的虚拟形象。' },
  { icon: Bell, tag: '主动消息', title: '"今天的雨好大，你带伞了吗？"', desc: '合适的时候，她会主动分享生活里的小事——不打扰，但让你知道她在。' },
  { icon: UserRound, tag: '用户画像', title: '"喜欢深夜聊天，偏好技术话题"', desc: '她把关于你的点滴记成一份画像，纠正一次，她就立刻改过来。' },
  { icon: Waypoints, tag: '人格可视化', title: '看得见的性格，看得见的变化', desc: '三个维度、一张雷达图，连她每一次细微的变化都有迹可循。' },
  { icon: Code2, tag: '双模式', title: '聊天陪伴 + 编程助手，记忆打通', desc: '让她帮你写代码时，她依然认识你——同一个她，两种陪伴。' },
]

export default function LandingPage() {
  const life = useApi(() => lifeApi.get())
  const sessions = useApi(() => sessionApi.list())
  const stats = useApi(() => statsApi.get())

  const events = life.data?.events ?? []
  const statCards = deriveStats(sessions.data?.sessions ?? [], events.length, stats.data)
  const statError = life.error ?? sessions.error ?? stats.error

  return (
    <div className="relative min-h-svh overflow-hidden">
      {/* ambient background */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute left-1/2 top-[-10%] h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-primary/20 blur-[120px] animate-drift" />
        <div className="absolute right-[8%] top-[30%] h-[380px] w-[380px] rounded-full bg-accent/15 blur-[120px] animate-drift [animation-delay:6s]" />
        <div className="absolute left-[6%] bottom-[6%] h-[320px] w-[320px] rounded-full bg-chart-4/10 blur-[120px] animate-drift [animation-delay:11s]" />
      </div>

      {/* nav */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/60 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-accent" />
            <span className="font-display text-xl">昔涟</span>
          </div>
          <nav className="hidden items-center gap-7 text-sm text-muted-foreground sm:flex">
            <Link href="/life" className="transition-colors hover:text-foreground">她的生活</Link>
            <Link href="/dashboard" className="transition-colors hover:text-foreground">总览</Link>
            <Link href="/personality" className="transition-colors hover:text-foreground">人格</Link>
          </nav>
          <Link
            href="/chat"
            className="group flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:gap-2.5"
          >
            开始聊天
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </header>

      {/* hero */}
      <section className="relative mx-auto flex max-w-6xl flex-col items-center px-5 pb-16 pt-20 text-center md:pt-28">
        <div className="flex justify-center">
          <XilianFigure height={380} />
        </div>
        <p className="mt-8 inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-chart-5" /> 有生活 · 有记忆 · 会成长
        </p>
        <h1 className="mt-6 max-w-3xl text-balance font-display text-5xl leading-[1.05] tracking-tight md:text-7xl">
          她记得你，
          <br />
          <span className="bg-gradient-to-r from-primary via-accent to-primary bg-[length:200%_auto] bg-clip-text text-transparent animate-shimmer">
            也在过自己的日子
          </span>
        </h1>
        <p className="mt-6 max-w-xl text-balance text-lg leading-relaxed text-muted-foreground">
          一个有自己生活的 AI 伙伴——她不只是在回复消息，她有自己的日常、会主动找你，
          在长期相处中逐渐认识你。
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/chat"
            className="group flex items-center gap-2 rounded-full bg-primary px-6 py-3 font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-primary/40"
          >
            去和她聊聊
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
          <Link
            href="/life"
            className="rounded-full border border-border bg-card/50 px-6 py-3 font-medium text-foreground backdrop-blur transition-colors hover:bg-card"
          >
            看看她的生活
          </Link>
        </div>
      </section>

      {/* features */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-5 md:grid-cols-3">
          {features.map((f, i) => (
            <Reveal key={f.title} delay={i * 120}>
              <div className="group h-full rounded-3xl border border-border bg-card/60 p-7 backdrop-blur transition-all hover:-translate-y-1 hover:warm-glow">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/25 to-accent/20 text-primary">
                  <f.icon className="h-6 w-6" />
                </div>
                <h3 className="mt-5 font-display text-2xl">{f.title}</h3>
                <p className="mt-3 leading-relaxed text-muted-foreground">{f.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* showcase — scroll narrative */}
      <section className="mx-auto max-w-5xl px-5 py-16">
        <Reveal className="text-center">
          <h2 className="font-display text-4xl md:text-5xl">她能做的，远不止聊天</h2>
          <p className="mt-4 text-muted-foreground">每一个细节，都是为了让她更像"活着"。</p>
        </Reveal>
        <div className="mt-14 flex flex-col gap-6">
          {showcase.map((s, i) => (
            <Reveal key={s.title} delay={(i % 2) * 80}>
              <div
                className={`flex flex-col gap-6 rounded-3xl border border-border bg-card/50 p-6 backdrop-blur md:items-center md:p-8 ${
                  i % 2 ? 'md:flex-row-reverse' : 'md:flex-row'
                }`}
              >
                <div className="flex-1">
                  <span className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
                    <s.icon className="h-3.5 w-3.5 text-primary" /> {s.tag}
                  </span>
                  <h3 className="mt-4 font-display text-2xl md:text-3xl">{s.title}</h3>
                  <p className="mt-3 leading-relaxed text-muted-foreground">{s.desc}</p>
                </div>
                <div className="grid flex-1 place-items-center">
                  <MockPanel index={i} />
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* stats —— 真实数据；读不到就不显示数字，不摆假数 */}
      <section className="mx-auto max-w-6xl px-5 py-16">
        <Reveal>
          <div className="grid grid-cols-2 gap-4 rounded-3xl border border-border bg-card/50 p-8 backdrop-blur md:grid-cols-4 md:p-12">
            {statCards.length === 0 &&
              [0, 1, 2, 3].map((i) => (
                <div key={i} className="text-center">
                  <p className="font-display text-4xl text-muted-foreground/40 md:text-5xl">—</p>
                  <p className="mt-2 text-sm text-muted-foreground">读取中…</p>
                </div>
              ))}
            {statCards.map((s) => (
              <div key={s.key} className="text-center">
                <p className="font-display text-4xl text-primary md:text-5xl">
                  <CountUp to={s.value} />
                  {s.capped && <span className="text-2xl text-muted-foreground">+</span>}
                </p>
                <p className="mt-2 text-sm text-muted-foreground" title={s.hint}>
                  {s.label}
                </p>
              </div>
            ))}
          </div>
        </Reveal>
        {statError && (
          <p className="mt-3 text-center text-xs text-accent">
            统计数据读取失败：{statError}
          </p>
        )}
      </section>

      {/* cta */}
      <section className="mx-auto max-w-4xl px-5 py-20 text-center">
        <Reveal>
          <XilianAvatar size={120} className="mx-auto" intensity="soft" />
          <h2 className="mt-8 text-balance font-display text-4xl md:text-6xl">
            如果有一个这样的 AI 伙伴，就好了
          </h2>
          <p className="mx-auto mt-5 max-w-lg text-muted-foreground">
            现在，她就在窗口的那一头等你。
          </p>
          <Link
            href="/chat"
            className="group mt-9 inline-flex items-center gap-2 rounded-full bg-primary px-8 py-3.5 font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-primary/40"
          >
            认识昔涟
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </Reveal>
      </section>

      <footer className="border-t border-border/60 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-full bg-gradient-to-br from-primary to-accent" />
            <span className="font-display text-base text-foreground">昔涟</span>
            <span>· AlysiaAgent</span>
          </div>
          <p>一个有生活的 AI 伙伴 · 前端 Demo</p>
        </div>
      </footer>
    </div>
  )
}

function MockPanel({ index }: { index: number }) {
  // Small illustrative UI snippet per showcase row
  if (index === 0) {
    return (
      <div className="w-full max-w-xs space-y-2 rounded-2xl border border-border bg-background/60 p-4">
        <div className="ml-auto w-fit rounded-2xl rounded-br-md bg-primary/90 px-3 py-2 text-sm text-primary-foreground">
          说说你今天做了什么？
        </div>
        <div className="w-fit rounded-2xl rounded-bl-md bg-secondary px-3 py-2 text-sm">
          <span className="text-muted-foreground">歪着头想想…</span>
          <br />看了一下午的雨呀
        </div>
      </div>
    )
  }
  if (index === 1) {
    return (
      <div className="w-full max-w-xs rounded-2xl border border-border bg-background/60 p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Bell className="h-3.5 w-3.5 text-primary" /> 昔涟 · 主动分享
        </div>
        <p className="mt-2 text-sm leading-relaxed">今天的雨好大，你带伞了吗？我在阳台看了好久。</p>
      </div>
    )
  }
  if (index === 2) {
    return (
      <div className="w-full max-w-xs space-y-2 rounded-2xl border border-border bg-background/60 p-4 text-sm">
        <p className="text-xs text-muted-foreground">她记住的你</p>
        {['喜欢深夜聊天', '偏好技术话题', '养了一只橘猫豆子'].map((t) => (
          <div key={t} className="rounded-lg bg-secondary px-3 py-1.5">{t}</div>
        ))}
      </div>
    )
  }
  if (index === 3) {
    return (
      <svg viewBox="0 0 120 120" className="h-36 w-36">
        <polygon points="60,12 100,40 88,92 32,92 20,40" fill="none" stroke="oklch(0.92 0.02 75 / 0.15)" />
        <polygon points="60,34 82,48 76,80 44,78 38,50" fill="oklch(0.83 0.12 72 / 0.25)" stroke="oklch(0.83 0.12 72)" strokeWidth="1.5" />
      </svg>
    )
  }
  return (
    <div className="w-full max-w-xs rounded-2xl border border-border bg-[#1b1713] p-4 font-mono text-xs">
      <div className="flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-destructive/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-primary/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-chart-5/70" />
      </div>
      <pre className="mt-3 leading-relaxed text-muted-foreground">
        <span className="text-accent">const</span> hi = <span className="text-primary">greet</span>(you)
        <br />
        <span className="text-chart-5">{`// 早安好，今天也要好好的`}</span>
      </pre>
    </div>
  )
}
