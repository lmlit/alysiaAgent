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
  /** ★ 9-25：强制 JSON 输出（OpenAI/DeepSeek 的 `response_format`）。
   *  仅用于要求结构化输出的非流式调用。**要求 prompt 里含 "json" 字样**，
   *  且不与 function calling 共用（provider 侧有互斥判断）。 */
  response_format?: 'json_object';
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
    // ★ 9-25 fix-session-summary-silent-failure：原 512 —— **对推理模型太小**。
    //   实测（scripts/verify-session-summary-fix.ts 的探针）：CHAT_MODEL 是推理模型，
    //   每次调用先花 ~242-258 tokens 在 reasoning 上，**可见内容与 reasoning 共用
    //   同一个 max_tokens 预算**。512 时对话稍长 → reasoning 膨胀 → 留给内容的额度为 0
    //   → 模型返回空响应（HTTP 200、content 0 字）。
    //
    //   这**同一个 512** 同时是两处故障的根因：
    //     - 会话摘要（session.summary 槽，同值）→ 线上 22 天 100% 失败
    //     - 每日反思（本槽，bootstrap.ts:200 引用它）→ 线上 7 天 11 次 empty response
    //   提到 2048，给 reasoning 留出余量。
    generateSummary: { temperature: 0.3, max_tokens: 2048 },
  },
  proactive: {
    personalize: { temperature: 0.7, max_tokens: 256 }, // 问候/关怀文案
  },
  profile: {
    extract: { temperature: 0.1, max_tokens: 1024 }, // 事实提取，低温
  },
  session: {
    // ★ 9-25 fix-session-summary-silent-failure：原来是 max_tokens 512 —— **太小**。
    //   摘要要返回 6 字段 JSON（含 1-3 条逐字原文摘句），中文下必然触顶被截断，
    //   截断即 JSON.parse 失败（线上 22 天 100% 失败的根因之一；8-28 加入
    //   character_perspective 字段后成功率从 55% 直接掉到 0%，就是被这 512 卡死）。
    //   提到 2048，并开 JSON 模式——从源头消除 markdown 围栏。
    summary: { temperature: 0.3, max_tokens: 2048, response_format: 'json_object' },
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
  // ★ 9-25：response_format 是字符串枚举，不是数字，单独处理（hasValue 只认 number）
  if (override.response_format !== undefined && override.response_format !== null) {
    out.response_format = override.response_format as SamplingSlot['response_format'];
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
export function slotToBody(slot: SamplingSlot | undefined): Record<string, unknown> {
  if (!slot) return {};
  const body: Record<string, unknown> = {};
  for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'max_tokens'] as const) {
    if (slot[key] !== undefined) body[key] = slot[key];
  }
  // ★ 9-25：API 要的是 { type: 'json_object' }，不是裸字符串（见 provider/openai.ts 同样的映射）
  if (slot.response_format !== undefined) {
    body.response_format = { type: slot.response_format };
  }
  return body;
}
