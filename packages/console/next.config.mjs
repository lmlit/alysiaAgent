/** @type {import('next').NextConfig} */

// 两种形态互斥（实测：output:'export' 下 rewrites 不生效并告警）：
//   dev  (`next dev`, NODE_ENV=development)：rewrites 代理 /api → 本地 server
//                                            （照抄 packages/webui/vite.config.ts 的既有约定）
//   prod (`next build`, NODE_ENV=production)：静态导出到 out/，
//                                            由 alysia server 同源托管——无代理、无 CORS
const isDev = process.env.NODE_ENV === 'development'
const apiTarget = process.env.ALYSIA_API ?? 'http://127.0.0.1:6185'

const nextConfig = {
  ...(isDev
    ? {
        async rewrites() {
          return [{ source: '/api/:path*', destination: `${apiTarget}/api/:path*` }]
        },
      }
    : { output: 'export' }),
  // ★ Next 16 默认拦截跨源 dev 资源：用 127.0.0.1 打开时所有 JS chunk 被 block，
  //   页面变成「没有 JS 的空壳」—— 数据永远停在「加载中」，看起来跟接口挂了一模一样。
  //   实测踩过：一整轮的截图与验证都是在 JS 被拦的状态下做的，还把现象归给了"后端慢"。
  //   localhost 与 127.0.0.1 都是常用入口，显式放行后者。
  allowedDevOrigins: ['127.0.0.1'],
  images: {
    unoptimized: true,
  },
}

export default nextConfig
