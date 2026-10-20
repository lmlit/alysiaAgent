// src/memory/services/OpenAILLMService.ts
// OpenAI-compatible LLM service. Works with any provider that exposes
// the /v1/chat/completions endpoint (OpenAI, DeepSeek, Moonshot, etc.).
//
// ★ 2026-10-20（change: unify-memory-llm-client；KI-3 + KI-9）：
//   本类**不再是独立实现**，而是 `MemoryLlmClient` 的适配器 ——
//   与生产（`modules/resources.ts` 的 `al:memory-llm`）**共用同一份代码**。
//
//   为什么必须这么改：在它还是独立实现的时候，两者已经分叉了 ——
//   生产有 120s 超时和 `[LLM:memory]` 观测，**本类一样都没有**，
//   而 E2E（`tests/memory/e2e/*`）测的正是本类 ⇒ **E2E 不代表生产**。
//   `pipeline-contract` 血案同源：本方法曾少声明第三参 `sampling` 而静默丢弃，
//   E2E 全绿、生产 400。
//
//   保留本类（而不是删掉）的理由：E2E / 单测的构造签名 `new OpenAILLMService(config)`
//   被 4 个文件使用，改签名是纯噪音。适配器只有 6 行，比改 4 个测试更便宜。
//
//   ⚠️ 与生产**唯二**的差异（都被 `tests/memory/unit/memory-llm-contract.test.ts` 锁住）：
//     ① 构造函数默认槽（`profile.extract`）—— 测试便利，生产不预置默认槽；
//     ② `throwOnEmpty: true` —— 空响应必须响亮失败，否则测试会拿空串继续跑。

import type { ServiceConfig } from './config.js';
import { DEFAULT_SAMPLING } from '../../provider/sampling.js';
import type { SamplingSlot } from '../../provider/sampling.js';
import { MemoryLlmClient } from './MemoryLlmClient.js';

export class OpenAILLMService {
  private readonly client: MemoryLlmClient;
  private readonly sampling: Partial<SamplingSlot>;

  constructor(config: ServiceConfig, sampling?: Partial<SamplingSlot>) {
    // ★ 8-10 采样参数统一（sampling-config-unify）：默认取 profile.extract 槽
    //   （提取/摘要类任务低温），可显式传其他槽
    this.sampling = { ...DEFAULT_SAMPLING.profile.extract, ...(sampling ?? {}) };
    this.client = new MemoryLlmClient(
      {
        baseUrl: config.chatBaseUrl,
        apiKey: config.chatApiKey,
        model: config.chatModel,
      },
      // 本类只服务测试/E2E：静默日志（不污染测试输出）+ 空响应抛错（失败要响）
      { throwOnEmpty: true },
    );
  }

  /**
   * 语义取**替换**而非合并——与构造函数注释「可显式传其他槽」一致；
   * 合并会让调用方**无法摆脱**默认槽的字段（例如去掉 json_object）。
   *
   * （该语义此前是本类的独立实现，现在由「传了就替换、没传才用默认」这一行承载，
   *   实际请求构造全部下沉到 `MemoryLlmClient`。）
   */
  async complete(
    systemPrompt: string,
    userPrompt: string,
    sampling?: Partial<SamplingSlot>,
  ): Promise<string> {
    return this.client.complete(systemPrompt, userPrompt, sampling ?? this.sampling);
  }
}
