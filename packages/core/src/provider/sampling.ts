// ★ 8-10 采样参数统一配置：一处入口、按场景分槽。
//   DEFAULT_SAMPLING 是硬编码 floor（无 config 也能起）；config.yml 的 sampling: 节
//   通过 AlysiaCoreOptions.sampling 深合并覆盖，缺省不报错。
//   注意：槽位内未设置的字段不会传给 API（undefined 跳过）——chat 默认空对象
//   = 保持"走服务端默认"的历史行为，想调时在 config 里配。

export interface SamplingSlot {
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  max_tokens?: number;
}

export interface SamplingConfig {
  /** 主对话 ReAct（她的"嗓子"，与 persona / memory_config 语义聚团） */
  chat: SamplingSlot;
  vision: { describe: SamplingSlot };
  life: { generateEvent: SamplingSlot; generateSummary: SamplingSlot };
  proactive: { personalize: SamplingSlot };
  /** 画像事实提取（SessionEnd + Cron 深度画像） */
  profile: { extract: SamplingSlot };
  /** 会话摘要（SessionEndProcessor） */
  session: { summary: SamplingSlot };
}

/** 递归 Partial：config.yml 只需覆盖需要的槽/字段 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const DEFAULT_SAMPLING: SamplingConfig = {
  // 主对话：历史行为是"不传参数走服务端默认"，默认空槽保持现状
  chat: {},
  vision: {
    describe: { temperature: 0.1, max_tokens: 200 }, // 图→文字，低温/准（迁移自 VisionBridge 硬编码）
  },
  life: {
    generateEvent: { temperature: 0.9 }, // 事件生成，偏高/活
    generateSummary: { temperature: 0.3, max_tokens: 512 }, // 每日摘要，低温/忠
  },
  proactive: {
    personalize: { temperature: 0.7, max_tokens: 256 }, // 问候/关怀文案
  },
  profile: {
    extract: { temperature: 0.1, max_tokens: 1024 }, // 事实提取，低温
  },
  session: {
    summary: { temperature: 0.3, max_tokens: 512 }, // 会话摘要，低温
  },
};

const hasValue = (v: unknown): v is number => v !== undefined && v !== null;

function mergeSlot(base: SamplingSlot, override?: DeepPartial<SamplingSlot>): SamplingSlot {
  if (!override) return { ...base };
  const out: SamplingSlot = { ...base };
  for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'max_tokens'] as const) {
    const v = override[key];
    if (hasValue(v)) out[key] = v;
  }
  return out;
}

/** 深合并用户配置到 DEFAULT（只覆盖存在的字段，undefined/null 跳过） */
export function mergeSampling(override?: DeepPartial<SamplingConfig>): SamplingConfig {
  if (!override) return structuredClone(DEFAULT_SAMPLING);
  return {
    chat: mergeSlot(DEFAULT_SAMPLING.chat, override.chat),
    vision: { describe: mergeSlot(DEFAULT_SAMPLING.vision.describe, override.vision?.describe) },
    life: {
      generateEvent: mergeSlot(DEFAULT_SAMPLING.life.generateEvent, override.life?.generateEvent),
      generateSummary: mergeSlot(DEFAULT_SAMPLING.life.generateSummary, override.life?.generateSummary),
    },
    proactive: { personalize: mergeSlot(DEFAULT_SAMPLING.proactive.personalize, override.proactive?.personalize) },
    profile: { extract: mergeSlot(DEFAULT_SAMPLING.profile.extract, override.profile?.extract) },
    session: { summary: mergeSlot(DEFAULT_SAMPLING.session.summary, override.session?.summary) },
  };
}

/** 把槽位转成可塞进请求 body 的参数字段（undefined 字段剔除） */
export function slotToBody(slot: SamplingSlot | undefined): Record<string, number> {
  if (!slot) return {};
  const body: Record<string, number> = {};
  for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'max_tokens'] as const) {
    if (slot[key] !== undefined) body[key] = slot[key];
  }
  return body;
}
