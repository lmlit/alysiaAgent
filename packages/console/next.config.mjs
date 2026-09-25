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
  images: {
    unoptimized: true,
  },
}

export default nextConfig
