/**
 * 记忆链路专用 LLM 客户端 —— **唯一实现**。
 *
 * ★ 2026-10-20（change: unify-memory-llm-client；KI-3 + KI-9）。
 *
 * ## 为什么要有这个类
 *
 * 在此之前记忆链路有**两套**客户端：
 *   ① 生产：`modules/resources.ts` 里的内联对象字面量（`al:memory-llm`）
 *   ② 测试/E2E：`memory/services/OpenAILLMService.ts`
 *
 * 两者**早就分叉了**，而且分叉方向最坏 —— E2E 测的那个**没有超时、没有观测**：
 *
 * | | 生产 | 旧 OpenAILLMService |
 * |---|---|---|
 * | 超时 | ✅ 120s（KI-21 的修复） | ❌ 没有 |
 * | `[LLM:memory]` 观测 | ✅ | ❌ |
 * | 空响应 | warn + 返回 `''` | **抛错** |
 *
 * KI-3 原文写「两者行为现已一致」—— 那句在 KI-21 落地后**已经不成立**。
 *
 * ## 刻意的差异（**只有两条，且都被测试锁住**）
 *
 * 1. **构造函数默认槽**：仅 `OpenAILLMService` 有（测试便利）。本类没有——
 *    构造时就塞默认槽会让「缺省 = 走服务端默认」这条退化成隐式行为。
 * 2. **`throwOnEmpty`**：E2E 要空响应**响亮失败**（否则测试会悄悄拿空串继续跑），
 *    生产要 warn + 返回空串（`SessionEndProcessor` 等按"空"处理，见 spec §4.1.3 契约 5）。
 *
 * 除这两条以外，两个入口发出的 request body 由契约测试保证**逐字相同**。
 */

import { slotToBody } from '../../provider/sampling.js';
import type { SamplingSlot } from '../../provider/sampling.js';

/**
 * 记忆链路的请求超时。
 *
 * ★ 2026-10-11（change: add-memory-llm-timeout）：原先**完全没有超时**，
 *   线上实测一次断网让 `extractProfile` 挂住 **7039529ms（117 分钟）**，
 *   HTTP 请求一直不返回、连接一起被拖死（KI-21）。
 *
 * **为什么是 120s 而不是聊天链路的 60s**：两条链路的延迟预算不同——
 *   `provider/openai.ts` 是**交互式**（用户在等回复）；本客户端是**批处理**
 *   （会话摘要 / 画像提取 / cron 深度重写），输出契约更长
 *   （`profile.extract` 为 `max_tokens: 4096` 的结构化 JSON）。
 *   已观测到的合法耗时：摘要 9785ms、人格调整 3084ms、生活事件 29705ms。
 *   120s 对它们有充分余量，同时把「无限等待」压到 2 分钟。
 *
 * ⚠️ 刻意**不做成配置项**——与 provider 的 60s 一致保持硬编码，避免配置面扩张。
 */
export const MEMORY_LLM_TIMEOUT_MS = 120_000;

/** 记忆链路要打的最少日志面（`ctx.logger` / `utils/logger` 都满足）。 */
export interface MemoryLlmLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface MemoryLlmEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface MemoryLlmOptions {
  /** 缺省静默（测试路径不必刷屏）；生产传 `ctx.logger`。 */
  logger?: MemoryLlmLogger;
  /** 缺省 {@link MEMORY_LLM_TIMEOUT_MS}；测试可注入短值验证 abort。 */
  timeoutMs?: number;
  /** 空响应是否抛错。缺省 `false`（= 生产语义：warn 后返回空串）。 */
  throwOnEmpty?: boolean;
  /**
   * ★ 2026-10-20（change: `let-memory-use-provider`）：**经 ProviderManager 走**（可选）。
   *
   * 传了它就走 `textChatWithFallback`（获得 fallback / 统一 provider 观测）；
   * 不传则维持原有的**直连 fetch**（行为完全不变）。
   *
   * ⚠️ 默认**不传** —— 收编会引入两处可观测差异（见 spec §4.1.4 契约 7.5）：
   *   ① provider 会多打一行 `[LLM]`（槽位归属仍是本类的 `[LLM:memory]`）
   *   ② 错误文案由 provider 生成，本类负责**翻译回契约 6.2 / 7.4 的格式**
   * 而且**今天只有一个 provider** ⇒ fallback 实际是空转，收益为零、风险非零。
   */
  provider?: MemoryLlmProvider;
  /**
   * 懒取 provider（**生产用它**，而不是传实例）。
   *
   * 为什么懒取：`al:memory-llm` 与 `al:provider` **没有依赖关系**（一个是批处理客户端、
   * 一个是 provider 池），声明 `inject: ['al:provider']` 会把两个模块的装配顺序绑死，
   * 且会让 10 个只测 memory-llm 的既有单测全部需要加桩 —— **那是为功能付的假成本**。
   * 改成"调用时再取"，装配顺序无关，未启用时也不会多一次 `ctx.get`。
   */
  providerRef?: () => MemoryLlmProvider | undefined;
  /** 走 provider 时尝试的备用 provider id（按序） */
  fallbackIds?: string[];
}

/** 只依赖 ProviderManager 的**最小形状**（便于测试与解耦） */
export interface MemoryLlmProvider {
  textChatWithFallback(
    req: {
      prompt: string;
      sessionId: string;
      systemPrompt?: string;
      sampling?: Partial<SamplingSlot>;
      timeoutMs?: number;
    },
    fallbackIds?: string[],
  ): Promise<{ role: 'assistant' | 'err'; completionText: string; usage?: unknown; finishReason?: string }>;
}

const SILENT_LOGGER: MemoryLlmLogger = { info() {}, warn() {} };

export class MemoryLlmClient {
  private readonly log: MemoryLlmLogger;
  private readonly timeoutMs: number;
  private readonly throwOnEmpty: boolean;
  private readonly provider?: MemoryLlmProvider;
  private readonly providerRef?: () => MemoryLlmProvider | undefined;
  private readonly fallbackIds: string[];

  constructor(
    private readonly endpoint: MemoryLlmEndpoint,
    opts: MemoryLlmOptions = {},
  ) {
    this.log = opts.logger ?? SILENT_LOGGER;
    this.timeoutMs = opts.timeoutMs ?? MEMORY_LLM_TIMEOUT_MS;
    this.throwOnEmpty = opts.throwOnEmpty ?? false;
    this.provider = opts.provider;
    this.providerRef = opts.providerRef;
    this.fallbackIds = opts.fallbackIds ?? [];
  }

  /**
   * 经 `ProviderManager` 走（★ 2026-10-20，change: `let-memory-use-provider`）。
   *
   * **本方法存在的意义是把两套错误语义对齐**，不是简单转发：
   * provider 用 `{role:'err', completionText}` 表达失败（**不抛**），
   * 而契约 6.2 / 7.4 要求「超时」与「API error <status>: <body>」两种可辨文案。
   * 所以这里做翻译，并**保留本类自己的 `[LLM:memory]` 观测行**（契约 5 钉的是这个标签）。
   */
  private async completeViaProvider(
    provider: MemoryLlmProvider,
    systemPrompt: string,
    userPrompt: string,
    sampling?: Partial<SamplingSlot>,
  ): Promise<string> {
    const start = Date.now();
    const resp = await provider.textChatWithFallback(
      {
        prompt: userPrompt,
        sessionId: 'memory-llm',
        systemPrompt,
        sampling,
        // ★ 关键：把本类的 120s 带过去 —— 否则记忆链路会被 60s 判死
        timeoutMs: this.timeoutMs,
      },
      this.fallbackIds,
    );

    if (resp.role === 'err') {
      const raw = String(resp.completionText ?? '');
      // 契约 6.2：超时文案必须含「超时」+ 秒数
      if (/timed out|timeout/i.test(raw)) {
        throw new Error(`LLM 请求超时（${this.timeoutMs / 1000}s）`);
      }
      // 契约 7.4：`LLM API error <status>: <body>`（provider 给的是 `API error …`，补前缀）
      throw new Error(/^LLM\b/.test(raw) ? raw : `LLM ${raw}`);
    }

    const content = resp.completionText || '';
    const usage = resp.usage as { input?: number; output?: number; total?: number; reasoningTokens?: number } | undefined;
    const tokenStr = usage ? `${usage.input}+${usage.output}=${usage.total}` : '?';
    this.log.info(
      `[LLM:memory] ${this.endpoint.model} → ${content.slice(0, 80).replace(/\n/g, ' ')}`
      + ` tokens=${tokenStr} finish=${resp.finishReason ?? '?'} reasoning=${usage?.reasoningTokens ?? '?'}`
      + ` (${Date.now() - start}ms) [via provider]`,
    );
    if (!content) {
      this.log.warn(
        `[LLM:memory] ${this.endpoint.model} returned EMPTY content — finish=${resp.finishReason ?? '?'}`
        + (resp.finishReason === 'length'
          ? ' → max_tokens 预算耗尽（推理吃光），该槽位需要更大的 max_tokens'
          : ' → 不是预算问题（finish≠length），需另查'),
      );
      if (this.throwOnEmpty) throw new Error('LLM API returned empty response (via provider)');
    }
    return content;
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    sampling?: Partial<SamplingSlot>,
  ): Promise<string> {
    // ★ 2026-10-20（change: `let-memory-use-provider`）：显式传了 provider（或懒取到）才走它
    const provider = this.provider ?? this.providerRef?.();
    if (provider) return this.completeViaProvider(provider, systemPrompt, userPrompt, sampling);
    const start = Date.now();
    // ★ 2026-10-11 add-memory-llm-timeout：超时走 `AbortController` +
    //   `Promise.race`（与 `provider/openai.ts` 同款）。**race 是必需的**——
    //   `AbortController` 无法中断 DNS / 连接建立阶段（libuv getaddrinfo 提交线程池后
    //   不可取消），只靠 abort 时网络故障仍会挂到系统超时。
    const controller = new AbortController();
    let timeoutTimer: NodeJS.Timeout | undefined;
    // ★ 2026-10-20（unify-memory-llm-client）：**为什么要有这个标志**——
    //   `controller.abort()` 会同步触发 fetch 的 reject，而 `race` 只认**先落定**的那个
    //   ⇒ 调用方拿到的会是底层 AbortError（"This operation was aborted"），
    //   而不是 KI-21 承诺的那句「LLM 请求超时」。实测在 mock 下必现，真 fetch 也一样险。
    //   所以「超时」由**这个标志**定义，而不是由谁先赢得 race 定义。
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        // 先 abort 释放底层连接/socket，再 reject —— 只抛不 abort 会泄漏连接
        controller.abort();
        reject(new Error(`LLM 请求超时（${this.timeoutMs / 1000}s）`));
      }, this.timeoutMs);
    });

    try {
      const fetchPromise = fetch(`${this.endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.endpoint.apiKey}`,
        },
        body: JSON.stringify({
          model: this.endpoint.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          ...slotToBody(sampling),
        }),
        signal: controller.signal,
      });
      // 防 unhandledRejection：race 已返回（超时/abort）后，挂起的底层请求
      // 最终失败时其 rejection 必须被消费（同 `provider/openai.ts`）
      fetchPromise.catch(() => {});
      const resp = await Promise.race([fetchPromise, timeoutPromise]);

      if (!resp.ok) {
        throw new Error(`LLM API error ${resp.status}: ${await resp.text().catch(() => '')}`);
      }
      const data = await resp.json() as any;
      const content: string = data?.choices?.[0]?.message?.content || '';

      // ★ 2026-10-11（instrument-memory-llm）：记忆链路是**独立于 OpenAIProvider 的
      //   第二个 LLM 客户端**（故意绕开 ProviderManager 直连 fetch）。
      //   此前它一条日志都不打，于是会话摘要 / 画像提取 / cron 深度重写 / 人格调整
      //   这四个槽位的失败**恰好落在观测盲区**——线上 8 天 10 次「空响应」+ 4 次
      //   `truncated=true` 全都看不到 finish_reason，无法按 spec §4.1.2 契约 4 判定。
      //   日志标签刻意用 `[LLM:memory]` 与聊天链路的 `[LLM]` 区分（两者失败处置不同）。
      const finishReason: string | undefined = data?.choices?.[0]?.finish_reason ?? undefined;
      const reasoningTokens: number | undefined =
        data?.usage?.completion_tokens_details?.reasoning_tokens ?? undefined;
      const usage = data?.usage;
      const tokenStr = usage
        ? `${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}`
        : '?';

      this.log.info(
        `[LLM:memory] ${this.endpoint.model} → ${content.slice(0, 80).replace(/\n/g, ' ')}`
        + ` tokens=${tokenStr} finish=${finishReason ?? '?'} reasoning=${reasoningTokens ?? '?'}`
        + ` (${Date.now() - start}ms)`,
      );

      // ★ 空响应要单独可见（spec §4.1.3 契约 5）："没内容"与"预算被推理吃光"
      //   此前在日志里长得一样，而后者有完全不同的处置（该槽要更大的 max_tokens）。
      if (!content) {
        this.log.warn(
          `[LLM:memory] ${this.endpoint.model} returned EMPTY content — finish=${finishReason ?? '?'}`
          + ` tokens=${tokenStr} reasoning=${reasoningTokens ?? '?'}`
          + (finishReason === 'length'
            ? ' → max_tokens 预算耗尽（推理吃光），该槽位需要更大的 max_tokens'
            : ' → 不是预算问题（finish≠length），需另查'),
        );
        // E2E 用：空响应必须响亮失败，否则测试会拿空串继续跑（见文件头「刻意的差异」）
        if (this.throwOnEmpty) {
          throw new Error(`LLM API returned empty response: ${JSON.stringify(data)}`);
        }
      }

      return content;
    } catch (err) {
      // 「超时」的判据是标志位，不是"谁先赢得 race"（见上面的 timedOut 说明）
      if (timedOut) throw new Error(`LLM 请求超时（${this.timeoutMs / 1000}s）`);
      throw err;
    } finally {
      // 成功路径也要清掉定时器，否则进程会挂着一个 120s 的 timer
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }
}
