import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { logger } from '@alysia/core';
import type { DeepPartial, SamplingConfig } from '@alysia/core';

export interface QQOfficialConfig {
  app_id: string;
  app_secret: string;
}

export interface QQConfig {
  protocol: 'onebot_v11';
  ws_port: number;
  http_port: number;
  access_token?: string;
}

export interface ServerConfig {
  bot: { name: string; ownerId: string };
  llm: { baseUrl: string; apiKey: string; model: string };
  embed: { baseUrl: string; apiKey: string; model: string };
  telegram: { token: string };
  qq?: QQConfig;
  qq_official?: QQOfficialConfig;
  server: {
    port: number;
    dataDir: string;
    workspaceDir: string;
    webuiToken?: string;
    /** ★ 9-25 server-bind-host：监听地址。缺省由 bootstrap 决定
     *  （桌面模式 127.0.0.1 / 服务模式 0.0.0.0，与改动前一致）。
     *  绑定回环时自动免鉴权——见 bootstrap 的 isLoopbackHost。 */
    host?: string;
  };
  features?: { codeMode?: boolean; shell?: boolean; filesystem?: boolean; streaming?: boolean };
  /**
   * **委托项目登记表**（★ 2026-10-17，change: `add-project-task-delegation`）。
   *
   * 键 = 项目 ID（模型只许用这里的键），值 = 宿主上的工作区与要用的 dsh profile。
   *
   * ⚠️ **路径只能来自这里**：模型/工具提交任务时**永远不能**自带工作目录或 profile
   *    （那等于把「在服务器上任意位置跑任意 profile」变成模型能力）。
   * ⚠️ 这是**宿主侧**路径：alysia server 在容器里看不到它，它只被**宿主上的 runner**使用
   *    （runner 从认领响应里拿到它，见 webui 的 `/api/project-tasks/next`）。
   */
  projects?: Record<string, { workspace: string; profile: string }>;
  /** ★ 8-10 采样参数统一配置（7 槽位，缺省走 core DEFAULT_SAMPLING floor） */
  sampling?: DeepPartial<SamplingConfig>;
}

export function loadConfig(path: string): ServerConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err: any) {
    throw new Error(`Failed to read config file "${path}": ${err.message}`);
  }
  // 环境变量替换: ${VAR} → process.env.VAR
  const interpolated = raw.replace(/\$\{(\w+)\}/g, (_, key) => {
    const val = process.env[key];
    if (val === undefined) {
      logger.warn(`[Config] Environment variable "${key}" is not set, using empty string`);
    }
    return val || '';
  });
  let data: any;
  try {
    data = parse(interpolated);
  } catch (err: any) {
    throw new Error(`Failed to parse config YAML: ${err.message}`);
  }
  return {
    bot: { name: data.bot?.name ?? 'Alysia', ownerId: data.bot?.ownerId ?? '' },
    llm: {
      baseUrl: data.llm?.baseUrl ?? 'https://api.deepseek.com/v1',
      apiKey: data.llm?.apiKey ?? '',
      model: data.llm?.model ?? 'deepseek-v4-flash',
    },
    embed: {
      baseUrl: data.embed?.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: data.embed?.apiKey ?? '',
      model: data.embed?.model ?? 'embedding-2',
    },
    telegram: { token: data.platforms?.telegram?.token ?? '' },
    qq: data.platforms?.qq ? {
      protocol: 'onebot_v11',
      ws_port: data.platforms.qq.ws_port ?? 6199,
      http_port: data.platforms.qq.http_port ?? 6186,
      access_token: data.platforms.qq.access_token,
    } : undefined,
    qq_official: data.platforms?.qq_official ? {
      app_id: data.platforms.qq_official.app_id ?? '',
      app_secret: data.platforms.qq_official.app_secret ?? '',
    } : undefined,
    server: {
      port: data.server?.port ?? 6185,
      dataDir: data.server?.dataDir ?? './data',
      workspaceDir: data.server?.workspaceDir ?? './data/workspace',
      // ★ 8-29 cr-p0-webui-auth：WebUI Bearer token（${ALYSIA_WEBUI_TOKEN} env 注入）
      webuiToken: data.server?.webuiToken ?? '',
      // ★ 9-25 server-bind-host：留 undefined 时由 bootstrap 按模式取默认，保持线上行为不变
      host: data.server?.host,
    },
    features: data.features ?? { codeMode: false },
    sampling: data.sampling ?? undefined,
    /**
     * ★ 2026-10-17（change: `add-project-task-delegation`）：委托项目登记表。
     *
     * ⚠️ **这个函数是逐字段挑选的** —— 加新配置段时漏这一行，就是
     *   「配置文件里写了、进程里没有」，而且**不会报错**。
     *   真机第一次跑就撞上了：容器里 `config.yml` 明明有 `projects:`，
     *   服务端却回「已登记：无」。所以下面用显式映射 + 坏条目留痕。
     */
    projects: sanitizeProjects(data.projects),
  };
}

/**
 * 只接受 `{ <id>: { workspace, profile } }` 形状。
 * 坏条目**丢掉并留痕**（不静默通过 —— 否则「配了但不生效」永远查不出来）。
 */
function sanitizeProjects(
  raw: unknown,
): Record<string, { workspace: string; profile: string }> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, { workspace: string; profile: string }> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const workspace = (value as { workspace?: unknown } | null)?.workspace;
    const profile = (value as { profile?: unknown } | null)?.profile;
    if (typeof workspace === 'string' && workspace !== '' && typeof profile === 'string' && profile !== '') {
      out[id] = { workspace, profile };
    } else {
      logger.warn(
        `[Config] projects.${id} 形状不对（需要 workspace 与 profile 两个非空字符串），已忽略`,
      );
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
