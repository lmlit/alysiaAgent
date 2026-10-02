/**
 * server 模块 —— `al:webui`
 *
 * 对应 `bootstrap.ts:277-319`：Fastify 管理面板（托管 Next.js console 静态导出；★ 10-02 起 Vue 旧前端已删）。
 *
 * ⚠️ **`staticDist` 由调用方算好传进来**，本模块不自己推路径。
 *   原因：原实现在 `bootstrap.ts` 里用 `dirname(fileURLToPath(import.meta.url))` 定位，
 *   从 `src/` 上溯两级到 `packages/`。搬到 `src/modules/` 后**多了一层**，
 *   同一段代码会静默指向 `packages/server/console/out`（不存在）→
 *   `existsSync` 为 false → **静态路由静默不注册**，SPA 白屏且无报错。
 *   （这正是 `docs/dsh-migration-guide.md` 坑 #2 记的同类坑。）
 *   路径解析留在知道自己在哪的 `bootstrap.ts`，本模块只管用。
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { resolveBindHost, needsAuth } from '../net.js';
import type { AlysiaCore } from '@alysia/core';
import type { Module } from '@alysia/core/kernel';
import type { RuntimeConfig } from './config.js';

export interface WebuiModuleOptions {
  /** 前端（Next.js console）静态产物目录的**候选路径**。
   *  由 bootstrap 以正确的上溯层级算好（见文件头说明）。
   *  是否采用由本模块决定：`index.html` 存在才用（★ 10-02 起不再看 isDesktop）。 */
  consoleDist?: string;
}

export const webuiModule: Module<WebuiModuleOptions> = {
  name: 'al:webui',
  provides: false,
  inject: ['al:core', 'al:config'],
  async apply(ctx, opts) {
    const { config, isDesktop } = ctx.get<RuntimeConfig>('al:config')!;
    const core = ctx.get<AlysiaCore>('al:core')!;

    try {
      const { createWebuiApp } = await import('../webui/server.js');

      // ★ 9-25 server-bind-host：绑定地址与鉴权范围解耦于 IS_DESKTOP。
      //   默认值不变（桌面 127.0.0.1 / 服务 0.0.0.0）——线上容器靠 0.0.0.0 做端口映射。
      //   本地想只绑回环：config.yml 里写 server.host: "127.0.0.1"。
      //   本地只绑回环：.env 里写 ALYSIA_HOST=127.0.0.1（不要写进 config.yml——那个文件会被部署到服务器）
      const bindHost = resolveBindHost(config.server.host, process.env.ALYSIA_HOST, isDesktop);
      const requireAuth = needsAuth(bindHost);

      // ★ 容器内绑回环 = 端口映射必然失效（外部永远连不上）。这是把本机配置误带进部署包的典型症状，
      //   必须响亮地喊出来，别让它变成一个"服务在跑但访问不了"的哑谜
      if (!requireAuth && existsSync('/.dockerenv')) {
        ctx.logger.error(
          `[WebUI] ⚠️⚠️ 容器内绑定回环地址（${bindHost}）—— docker 端口映射会失效，外部访问不了！` +
          '请移除 config.yml 的 server.host，或把 ALYSIA_HOST 从容器环境里去掉',
        );
      }

      const webuiToken = config.server.webuiToken ?? '';
      // ★ 9-24 console-local-serve：托管 packages/console（Next.js 静态导出）
      // ★ 10-02 remove-packages-webui：去掉 isDesktop 门与 webui 回落——旧前端包已删，
      //   没构建 console 就是「只有 API、没有页面」，不存在第二候选。
      //   （原 isDesktop 门是 webui 时代的分流：桌面模式只托 webui。
      //   ALYSIA_DESKTOP=1 开关本身保留，但它现在的语义只剩「跳过 IM 适配器/主动推送」，
      //   不再影响前端托管——本地 UI-only 实例（如 .video-demo/start-server.ps1）现在只会拿到 console）
      const staticDist = opts?.consoleDist && existsSync(join(opts.consoleDist, 'index.html'))
        ? opts.consoleDist
        : undefined;
      const webui = createWebuiApp(core, { webuiToken, requireAuth, staticDist });
      await webui.listen({ port: config.server.port, host: bindHost });

      const frontend = staticDist ? 'console (Next.js)' : '无（仅 /api/*）';
      const authNote = requireAuth ? '鉴权: 开' : '鉴权: 关（回环地址，仅本机可达）';
      ctx.logger.info(`WebUI on http://${bindHost === '0.0.0.0' ? 'localhost' : bindHost}:${config.server.port} — 前端: ${frontend} · 监听 ${bindHost} · ${authNote}`);

      if (!staticDist) {
        // 没前端不是致命错（API 仍可用），但绝不能静默——否则用户会以为"服务挂了"
        ctx.logger.warn('[WebUI] packages/console/out 不存在 —— 静态页面未托管（/api/* 正常）。构建：pnpm --filter @alysia/console build');
      }
      if (requireAuth && !webuiToken) {
        ctx.logger.warn('[WebUI] ⚠️ 未配置 server.webuiToken（config.yml 或 ALYSIA_WEBUI_TOKEN 环境变量）——/api/* 已全部拒绝(401)。配置后重启生效');
      }
      if (!requireAuth) {
        ctx.logger.info('[WebUI] 绑的是回环地址，/api/* 免鉴权。要对外提供服务请改 server.host（改后自动恢复鉴权）');
      }
    } catch (err: any) {
      // 原实现同样吞掉 WebUI 失败——服务本体（QQ 机器人）不该因管理面板起不来而挂掉
      ctx.logger.error('WebUI init failed:', err.message);
    }
  },
};
