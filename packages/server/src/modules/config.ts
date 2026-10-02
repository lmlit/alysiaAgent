/**
 * server 模块 —— `al:config`
 *
 * 对应 `bootstrap.ts` 的：dotenv 加载 + `loadConfig()` + `IS_DESKTOP` 判定。
 *
 * ⚠️ `.env` **必须在 `loadConfig()` 之前**加载——config.yml 里的 `${VAR}` 插值依赖它。
 *   （原实现靠 ESM import 提升把 dotenv 放在文件顶部，本模块把它显式化成顺序。）
 */

import { resolve } from 'path';
import dotenv from 'dotenv';
import { loadConfig } from '../config.js';
import type { ServerConfig } from '../config.js';
import type { Module } from '@alysia/core/kernel';

export interface RuntimeConfig {
  config: ServerConfig;
  /** `ALYSIA_DESKTOP=1`：跳过 IM 适配器与主动推送，只起 core + Web 面板（纯 UI 本地调试用）。
   *  ★ 10-02 起不影响前端托管：静态页面一律托 console（webui 已删），见 modules/webui.ts */
  isDesktop: boolean;
}

export interface ConfigModuleOptions {
  /** 配置文件路径；缺省取 `ALYSIA_CONFIG` 环境变量，再缺省 `./config.yml` */
  path?: string;
}

export const configModule: Module<ConfigModuleOptions> = {
  name: 'al:config',
  apply(ctx, opts) {
    const envPath = resolve(process.cwd(), '..', '..', '.env');
    const envResult = dotenv.config({ path: envPath, quiet: true });
    // 此刻 logger 还没 configure，这行只进控制台（与原实现一致）
    if (envResult.error) {
      ctx.logger.debug('.env file not found, using existing env vars');
    } else {
      ctx.logger.info(`.env loaded from ${envPath}`);
    }

    const path = process.env.ALYSIA_CONFIG || opts?.path || './config.yml';
    ctx.provide('al:config', {
      config: loadConfig(path),
      isDesktop: process.env.ALYSIA_DESKTOP === '1',
    } satisfies RuntimeConfig);
  },
};
