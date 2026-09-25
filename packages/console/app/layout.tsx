import type { Metadata, Viewport } from 'next'
import { Inter, Instrument_Serif } from 'next/font/google'
import { RippleCursor } from '@/components/ripple-cursor'
import { TokenGate } from '@/components/token-gate'
import { Live2DLayer } from '@/components/live2d/live2d-layer'
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
    <html lang="zh-CN" className={`dark ${inter.variable} ${instrumentSerif.variable}`}>
      <body className="antialiased">
        <RippleCursor />
        <TokenGate />
        {/* ★ Live2D 持久层：放 root layout 才能覆盖所有页面（含不走 AppShell 的 landing `/`），
            实例跨路由不重建 —— 换页不重载 9MB 模型。见 change: live2d-persist-across-pages */}
        <Live2DLayer>{children}</Live2DLayer>
      </body>
    </html>
  )
}
