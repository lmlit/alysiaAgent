import type { Metadata, Viewport } from 'next'
import { Inter, Instrument_Serif } from 'next/font/google'
import { RippleCursor } from '@/components/ripple-cursor'
import { TokenGate } from '@/components/token-gate'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-display',
  display: 'swap',
})

export const metadata: Metadata = {
  title: '昔涟 · 一个有生活的 AI 伙伴',
  description:
    '她不只是在等你说话——她有自己的日常、会主动找你，在长期相处中逐渐认识你。',
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#231f1a',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`dark ${inter.variable} ${instrumentSerif.variable}`}
    >
      <head>
        {/* ★ 防闪烁（no-FOUC）：主题必须在**首次绘制之前**定下。
            放 useEffect 里会先画一帧默认暖墨、再跳成 sakura —— 那次变色用户看得见。

            这里刻意**不做白名单校验**：非法 id 在 CSS 里没有对应的 [data-theme] 块，
            会自动落回 :root 的暖墨，天然安全，也就不必在此维护一份 id 列表。

            ★ suppressHydrationWarning 是必须的：本脚本在 hydration 之前就改了 <html>
            的属性，React 会对不上 —— 这是防闪烁必须付的代价，不是 bug。
            键名与主题 id 见 lib/theme/theme.ts（唯一事实源）。 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('alysia-theme');if(t){document.documentElement.dataset.theme=t}}catch(e){}})()",
          }}
        />
      </head>
      <body className="antialiased">
        <RippleCursor />
        <TokenGate />
        {/*
          ★ Live2D 已于 2026-10-03 下线（change: sticker-figure）：大形象改用表情包轮换。

          代码**原样保留**（`lib/live2d/`、`components/live2d/` 都没动），只是不再挂载这一层 ——
          因为没有别处消费它了，挂着只会白白预载一个 9MB 模型、还占着加载期空白。

          想回去：把 <Live2DLayer>{children}</Live2DLayer> 放回这里，
          并恢复 xilian-figure 里的槽位注册（git 历史里有）。
        */}
        {children}
      </body>
    </html>
  )
}
