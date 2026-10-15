'use client'

import { ArrowUpRight, Code2, Info } from 'lucide-react'
import { XilianFigure } from '@/components/xilian-figure'
import { Reveal } from '@/components/reveal'

/**
 * 编程模式的引导页（change: code-mode-entry）。
 *
 * ★ 为什么不从侧栏直接跳 `dsh://`：
 *   自定义协议在**没装 dsh 的机器上点了毫无反应** —— 用户看到的是"按钮坏了"，
 *   而不是"我还没装"。何况跳出去之后没有任何解释，人不知道自己被送到了哪。
 *   所以侧栏指向本页，本页负责说清三件事：**去哪儿 / 为什么去 / 没装怎么办**。
 *
 * ★ 人格与记忆怎么带过去，不归本页管 —— 那是 dsh 侧通道的事
 *   （见 `openspec/specs/dsh-adapter/spec.md`）。这里只负责"把人送过去"。
 */

const DSH_PROTOCOL = 'dsh://'

export function CodeEntry() {
  return (
    <div className="relative min-h-svh overflow-hidden">
      {/* 环境光 —— 与首页同一套手法，保证两页观感连贯 */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px]">
        <div className="absolute left-1/2 top-[-12%] h-[460px] w-[720px] max-w-full -translate-x-1/2 rounded-full bg-primary/15 blur-[130px] animate-drift" />
        <div className="absolute right-[12%] top-[26%] h-[300px] w-[300px] rounded-full bg-accent/10 blur-[120px] animate-drift [animation-delay:7s]" />
      </div>

      <section className="mx-auto flex max-w-3xl flex-col items-center px-5 pb-20 pt-16 text-center md:pt-24">
        {/* 形象沿用表情包轮换 —— 她在这页也还是她 */}
        <XilianFigure height={300} />

        <p className="mt-8 inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur">
          <Code2 className="h-3.5 w-3.5 text-primary" />
          编程模式
        </p>

        <h1 className="mt-6 text-balance font-display text-4xl leading-[1.1] tracking-tight md:text-6xl">
          换个地方，
          <br />
          <span className="bg-gradient-to-r from-primary via-accent to-primary bg-[length:200%_auto] bg-clip-text text-transparent animate-shimmer">
            我接着帮你做事
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-lg text-balance text-lg leading-relaxed text-muted-foreground">
          聊天的时候我在陪你。要改代码、翻文件、跑命令——跟我去那边，
          平时攒下的记忆和脾气，那边一样认得你。
        </p>

        <a
          href={DSH_PROTOCOL}
          className="group mt-10 inline-flex items-center gap-2 rounded-full bg-primary px-7 py-3.5 font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-primary/40"
        >
          打开 DeepSeek Harness
          <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </a>

        <p className="mt-7 inline-flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="max-w-md text-left">
            它会以独立窗口打开。要是点了没反应，多半是这台机器还没装——
            那就先在这儿聊着，人家也不催你。
          </span>
        </p>
      </section>
    </div>
  )
}
