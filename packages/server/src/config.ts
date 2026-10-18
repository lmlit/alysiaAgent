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
  projects?: Record<string, { workspace: string; profile: string; publicUrl?: string }>;
  /**
   * ★ 2026-10-18（change: `gate-project-tasks-to-offpeak`）：委托任务的执行窗口。
   *
   * 规则（北京时间）：高峰 = 周一至周五（**不含**法定节假日）9:00–12:00、14:00–18:00；
   * 其余全部（含周末与节假日全天）为空闲。**高峰时段只排队，不执行**（钱按执行时间算）。
   *
   * ⚠️ `holidays` **不内置**：法定节假日每年公布、还涉及调休，猜一份错的表比没有更糟。
   *    未列出的日期按工作日处理 ⇒ 窗口照常生效 ⇒ 只会更省，不会多花。
   */
  projectTasks?: {
    holidays?: string[];
    peakWindows?: Array<[number, number]>;
    /**
     * 【**排障用**，生产别配】把窗口判定固定在这个时刻（ISO 8601）。
     *
     * 为什么需要它：高峰分支只在工作日 9-12/14-18 触发 ——
     * 想在生产上验证"闸门真的拦得住"，只能等到周一上午，这不现实。
     * 配了它会打 WARN（醒目到不会被忘掉）。
     */
    nowOverride?: string;
  };
  /**
   * ★ 2026-10-18（change: `let-her-start-her-own-projects`）：**她自己**在闲置时发起
   * 一件小事（做个小页面）。默认**关闭** —— 这是"她自己花钱干活"，必须显式打开。
   */
  selfActivity?: {
    enabled: boolean;
    /** 在哪个项目里做（留空 = 用登记列表最后一个） */
    projectId?: string;
    /** 每天最多几次（默认 1） */
    dailyCap?: number;
    /** 用户安静多久后才考虑（默认 6h） */
    minIdleHours?: number;
    /** 两次之间至少隔多久（默认 24h） */
    minGapHours?: number;
    /** 允许它在任务里自己发布（默认 **false**：她可以决定做什么，上线留给对话里的人） */
    allowPublish?: boolean;
    /** 考虑间隔（分钟，默认 30，最小 5） */
    intervalMinutes?: number;
  };
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
    // ★ 逐字段挑选：新增配置段**必须**在这里映射，否则就是"配置写了但没人看见"
    projectTasks: sanitizeProjectTasks((data as { projectTasks?: unknown }).projectTasks),
    // ★ 逐字段挑选（同一个坑）：自发起配置也要显式映射
    selfActivity: sanitizeSelfActivity((data as { selfActivity?: unknown }).selfActivity),
  };
}

/**
 * 只接受 `{ <id>: { workspace, profile } }` 形状。
 * 坏条目**丢掉并留痕**（不静默通过 —— 否则「配了但不生效」永远查不出来）。
 */
/**
 * 执行窗口的配置清洗（★ change: `gate-project-tasks-to-offpeak`）。
 *
 * 只接受两种东西：`holidays`（`YYYY-MM-DD` 字符串数组）与 `peakWindows`（`[起, 止]` 分钟对）。
 * **形状不对的一律忽略并留痕** —— 静默接受一个坏窗口会让"省钱"变成"根本没拦住"。
 */
export function sanitizeProjectTasks(
  raw: unknown,
): { holidays?: string[]; peakWindows?: Array<[number, number]>; nowOverride?: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: { holidays?: string[]; peakWindows?: Array<[number, number]>; nowOverride?: string } = {};

  // 【排障用】固定时钟：只在能解析成有效时间时接受，且**大声留痕**
  const ov = (raw as { nowOverride?: unknown }).nowOverride;
  if (typeof ov === 'string' && ov.trim()) {
    const t = Date.parse(ov.trim());
    if (Number.isFinite(t)) {
      out.nowOverride = new Date(t).toISOString();
      logger.warn(
        `[Config] ⚠️ projectTasks.nowOverride 生效：窗口判定被固定为 ${out.nowOverride} ` +
          `（**排障用**，生产请删掉这一项）`,
      );
    } else {
      logger.warn(`[Config] projectTasks.nowOverride 不是有效时间（"${ov}"），已忽略`);
    }
  }

  const holidays = (raw as { holidays?: unknown }).holidays;
  if (Array.isArray(holidays)) {
    const ok = holidays.filter(
      (d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()),
    );
    if (ok.length !== holidays.length) {
      logger.warn(
        `[Config] projectTasks.holidays 有 ${holidays.length - ok.length} 项不是 YYYY-MM-DD，已忽略`,
      );
    }
    if (ok.length > 0) out.holidays = ok.map(d => d.trim());
  }

  const peak = (raw as { peakWindows?: unknown }).peakWindows;
  if (Array.isArray(peak)) {
    const ok: Array<[number, number]> = [];
    for (const item of peak) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [a, b] = item as unknown[];
      if (
        typeof a === 'number' && typeof b === 'number' &&
        Number.isFinite(a) && Number.isFinite(b) &&
        a >= 0 && b <= 24 * 60 && a < b
      ) {
        ok.push([a, b]);
      } else {
        logger.warn(`[Config] projectTasks.peakWindows 有一项形状不对（要 [起,止] 分钟且起<止），已忽略`);
      }
    }
    if (ok.length > 0) out.peakWindows = ok;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 自发起配置的清洗（★ change: `let-her-start-her-own-projects`）。
 *
 * ⚠️ **默认关闭**：不写 `enabled: true` 就永远不发 —— "她自己花钱干活"必须显式打开。
 * 数值字段只接受有限正数，形状不对就**回落默认**（否则配个 0 会变成"无限次"）。
 */
export function sanitizeSelfActivity(
  raw: unknown,
): {
  enabled: boolean;
  projectId?: string;
  dailyCap?: number;
  minIdleHours?: number;
  minGapHours?: number;
  allowPublish?: boolean;
  intervalMinutes?: number;
} | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, dflt: number, min: number): number => {
    const n = typeof v === 'number' ? v : Number.NaN;
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  const out = {
    enabled: r.enabled === true,
    ...(typeof r.projectId === 'string' && r.projectId.trim() ? { projectId: r.projectId.trim() } : {}),
    dailyCap: num(r.dailyCap, 1, 0),
    minIdleHours: num(r.minIdleHours, 6, 0),
    minGapHours: num(r.minGapHours, 24, 0),
    allowPublish: r.allowPublish === true,
    intervalMinutes: Math.max(5, num(r.intervalMinutes, 30, 5)),
  };
  if (out.enabled) {
    logger.info(
      `[Config] selfActivity 已开启：project=${out.projectId ?? '(自动)'} 日上限 ${out.dailyCap} ` +
        `闲置≥${out.minIdleHours}h 间隔≥${out.minGapHours}h allowPublish=${out.allowPublish}`,
    );
  }
  return out;
}

function sanitizeProjects(  raw: unknown,
): Record<string, { workspace: string; profile: string; publicUrl?: string }> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, { workspace: string; profile: string; publicUrl?: string }> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const workspace = (value as { workspace?: unknown } | null)?.workspace;
    const profile = (value as { profile?: unknown } | null)?.profile;
    const publicUrl = (value as { publicUrl?: unknown } | null)?.publicUrl;
    if (typeof workspace === 'string' && workspace !== '' && typeof profile === 'string' && profile !== '') {
      out[id] = {
        workspace,
        profile,
        // 地址是可选的；**给了就必须是 http(s)**，否则当没给（不猜、不拼）
        ...(typeof publicUrl === 'string' && /^https?:\/\//.test(publicUrl.trim())
          ? { publicUrl: publicUrl.trim() }
          : {}),
      };
    } else {
      logger.warn(
        `[Config] projects.${id} 形状不对（需要 workspace 与 profile 两个非空字符串），已忽略`,
      );
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
