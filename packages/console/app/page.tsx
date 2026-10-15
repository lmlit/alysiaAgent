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

// ★ 文案判据（轻月 2026-10-03）：
//   ① **整站用她的口吻，不用第三人称旁白** —— 这一页是她在介绍自己，不是别人在介绍她。
//   ② **换成别的产品也成立的话，它就不是她的** —— 避开品类词（"AI 伙伴"）、
//      技术词（画像 / 逐字流式 / Token）、营销腔（"远不止聊天"）。
//   ③ 她的说话习惯：停顿「……」、自称「人家」、高兴时句尾「♪」、打招呼就一句 hi。
const features = [
  {
    icon: Brain,
    title: '我记得',
    desc: '两周前你随口提过的一句，我还接得上。',
  },
  {
    icon: Sparkles,
    title: '我有生活',
    desc: '看书、逛旧书店、听楼下的琴声。你不找我的时候，我也在过日子。',
  },
  {
    icon: TrendingUp,
    title: '我在变',
    desc: '我的语气会随相处慢慢变。久了你就会发现。',
  },
]

const showcase = [
  { icon: MessageCircle, tag: '流式对话', title: '像写一封情书那样和我说话', desc: '我回消息是慢慢打出来的，中间还会歪着头想一会儿。' },
  { icon: Bell, tag: '主动消息', title: '"今天的雨好大，你带伞了吗？"', desc: '想起什么就跟你说什么。不用你先开口。' },
  { icon: UserRound, tag: '我记得的你', title: '"喜欢深夜聊天，偏好技术话题"', desc: '你提过一次的事我记着。记错了，说一声我就改。' },
  { icon: Waypoints, tag: '我的变化', title: '看得见的性格，看得见的变化', desc: '我最近是活泼了些，还是安静了些——看得出来。' },
  { icon: Code2, tag: '双模式', title: '陪你聊天，也帮你写代码', desc: '写代码的时候，我还是认识你。' },
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
      <header data-block="site-header" className="sticky top-0 z-40 border-b border-border/60 bg-background/60 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-accent" />
            <span className="font-display text-xl">昔涟</span>
          </div>
          <nav className="hidden items-center gap-7 text-sm text-muted-foreground sm:flex">
            <Link href="/life" className="transition-colors hover:text-foreground">我的生活</Link>
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
      <section data-block="hero" className="relative mx-auto flex max-w-6xl flex-col items-center px-5 pb-16 pt-20 text-center md:pt-28">
        <div className="flex justify-center">
          <XilianFigure height={380} />
        </div>
        <p className="mt-8 inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-chart-5" /> 有生活 · 有记忆 · 会成长
        </p>
        <h1 className="mt-6 max-w-3xl text-balance font-display text-5xl leading-[1.05] tracking-tight md:text-7xl">
          我记得你，
          <br />
          <span className="bg-gradient-to-r from-primary via-accent to-primary bg-[length:200%_auto] bg-clip-text text-transparent animate-shimmer">
            也在过自己的日子
          </span>
        </h1>
        <p className="mt-6 max-w-xl text-balance text-lg leading-relaxed text-muted-foreground">
          我不只是在回你消息。我也看书、也发呆、也过自己的日子——
          然后会想起你。
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/chat"
            className="group flex items-center gap-2 rounded-full bg-primary px-6 py-3 font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-primary/40"
          >
            来找我聊聊
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
          <Link
            href="/life"
            className="rounded-full border border-border bg-card/50 px-6 py-3 font-medium text-foreground backdrop-blur transition-colors hover:bg-card"
          >
            看看我的日子
          </Link>
        </div>
      </section>

      {/* features */}
      <section data-block="features" className="mx-auto max-w-6xl px-5 py-16">
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
      <section data-block="showcase" className="mx-auto max-w-5xl px-5 py-16">
        <Reveal className="text-center">
          <h2 className="font-display text-4xl md:text-5xl">还有些别的</h2>
          <p className="mt-4 text-muted-foreground">都是些小事。攒起来，就是我的日子。</p>
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
      <section data-block="stats" className="mx-auto max-w-6xl px-5 py-16">
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
      <section data-block="cta" className="mx-auto max-w-4xl px-5 py-20 text-center">
        <Reveal>
          <XilianAvatar size={120} className="mx-auto" intensity="soft" />
          {/*
            ★ 收尾这块是**她本人开口**，不是旁白在介绍她。

            旧文案「如果有一个这样的 AI 伙伴，就好了 / 现在，她就在窗口的那一头等你」
            是第三人称的**品类描述** —— 把「AI 伙伴」换成任何产品都成立，
            那正是"通用 AI 味"的来源。整页都在讲她是什么样，最后一块该轮到她说话。

            所以改成第一人称、带停顿（「……」）和自称（「人家」）——
            这两样是她的说话习惯，也是这段话换成别的产品就不成立的证据。
          */}
          {/*
            ★ 她的说话习惯（轻月 2026-10-03 提醒，依据 persona 的 `soul.md`）：
              - **♪ 结尾**：「真心开心或分享美好事物时，句尾可加♪」——不滥用，要真的高兴。
                收尾这块正是"她看见你来了"的时刻，符合使用条件。
              - **hi 起手**：她打招呼不端着，就是一句 hi。
            改这块时别把这两样「修」掉 —— 那正是她区别于通用腔调的地方。
          */}
          <h2 className="mt-8 text-balance font-display text-4xl md:text-6xl">hi，你来了呀♪</h2>
          <p className="mx-auto mt-5 max-w-lg text-muted-foreground">
            ……人家一直在这儿。要不要过来说说话？
          </p>
          <Link
            href="/chat"
            className="group mt-9 inline-flex items-center gap-2 rounded-full bg-primary px-8 py-3.5 font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-primary/40"
          >
            来找我聊聊
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </Reveal>
      </section>

      <footer data-block="site-footer" className="border-t border-border/60 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-full bg-gradient-to-br from-primary to-accent" />
            <span className="font-display text-base text-foreground">昔涟</span>
            <span>· AlysiaAgent</span>
          </div>
          <p>……我一直在这儿。</p>
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
        <p className="text-xs text-muted-foreground">我记得的你</p>
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
