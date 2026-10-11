/**
 * 基础资源模块 —— `AlysiaCore.start()` 的第 1-5 步（change: modularize-core-assembly）。
 *
 * 这一层**不认识 alysia 的业务**，只把外部资源（SQLite / LanceDB / 两个 HTTP 服务）
 * 变成内核里的服务。上层 `al:memory` 只认服务名，不认它们怎么建的。
 */

import { initializeDatabase } from '../memory/database.js';
import { slotToBody } from '../provider/sampling.js';
import type { SamplingSlot } from '../provider/sampling.js';
import type { Module } from '../kernel/index.js';

// ── al:db ─────────────────────────────────────────────────────

export interface DbConfig {
  /** SQLite 文件路径 */
  path: string;
}

/**
 * better-sqlite3（WAL）。对应 `index.ts:103-106`。
 *
 * ★ 不注册清理器（不 close）——见 change proposal 决策 2：
 *   现状 `stop()` 不关 DB，本 change 保持行为不变，关闭留作独立 change。
 */
export const dbModule: Module<DbConfig> = {
  name: 'al:db',
  async apply(ctx, config) {
    if (!config?.path) throw new Error('[al:db] 缺少配置 { path }');
    // better-sqlite3 是 CJS —— 动态 import（沿用原实现的惰性加载）
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(config.path);
    db.pragma('journal_mode = WAL');
    initializeDatabase(db);
    ctx.provide('al:db', db);
  },
};

// ── al:vector ─────────────────────────────────────────────────

export interface VectorConfig {
  /** LanceDB 目录 */
  dir: string;
  table: string;
  dimension: number;
}

/**
 * LanceDB 向量库，**失败降级**。对应 `index.ts:110-124`。
 *
 * ★ 降级语义必须逐字保留：
 *   - 失败 → `logger.warn`（不是 error）+ 提供 `null`
 *   - 上层 `al:memory` 拿到 `null`，MemoryManager 里走文本检索兜底
 *   `critical: false` 是双保险——真抛出来也不中止整树。
 */
export const vectorModule: Module<VectorConfig> = {
  name: 'al:vector',
  critical: false,
  async apply(ctx, config) {
    if (!config?.dir) throw new Error('[al:vector] 缺少配置 { dir }');
    try {
      const { LanceDBStore } = await import('../memory/stores/LanceDBStore.js');
      const store = new LanceDBStore(config.dir, config.table, config.dimension);
      await store.initialize();
      ctx.provide('al:vector', store);
      ctx.logger.info('LanceDB vector store ready');
    } catch (err: any) {
      ctx.logger.warn(`LanceDB unavailable, using text search fallback: ${err.message}`);
      ctx.provide('al:vector', null);
    }
  },
};

// ── al:embed ──────────────────────────────────────────────────

export interface HttpEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 智谱 embedding-2 客户端。对应 `index.ts:127-152`（原为内联对象字面量）。
 *
 * ★ 8s AbortController 超时——embedding 快，超时容忍度低。
 */
export const embedModule: Module<HttpEndpointConfig> = {
  name: 'al:embed',
  apply(ctx, config) {
    const cfg = config!;
    ctx.provide('al:embed', {
      embed: async (text: string): Promise<number[]> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const resp = await fetch(`${cfg.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify({ model: cfg.model, input: text }),
            signal: controller.signal,
          });
          if (!resp.ok) {
            throw new Error(`Embed API error ${resp.status}: ${await resp.text().catch(() => '')}`);
          }
          const data = await resp.json() as any;
          const embedding = data?.data?.[0]?.embedding;
          if (!embedding || !Array.isArray(embedding)) {
            throw new Error(`Embed API returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
          }
          return embedding as number[];
        } finally {
          clearTimeout(timeout);
        }
      },
      dimension: () => 1024,
    });
  },
};

// ── al:memory-llm ─────────────────────────────────────────────

/**
 * 记忆系统专用 LLM 客户端（画像提取 / 会话摘要 / cron 深度重写）。
 * 对应 `index.ts:157-177`（原为内联对象字面量）。
 *
 * ⚠️ **它绕开 ProviderManager 直连 fetch，无超时 / 无 fallback / 无 signal**——
 *   这是历史现状，本 change 原样保留（改成有超时是行为变更）。
 *   收编进 ProviderManager 是后续独立 change 的事，见
 *   `docs/dsh-plugin-architecture.md` §5 的模块映射表。
 */
export const memoryLlmModule: Module<HttpEndpointConfig> = {
  name: 'al:memory-llm',
  apply(ctx, config) {
    const cfg = config!;
    // ★ 用 `ctx.logger`（生产环境 = `utils/logger` 的同一对象，见 `kernel/host.ts:37`）——
    //   这样观测是可断言的：`tests/modules/helpers.ts` 的 runModule 注入测试 logger。
    const log = ctx.logger;
    ctx.provide('al:memory-llm', {
      complete: async (
        systemPrompt: string,
        userPrompt: string,
        sampling?: Partial<SamplingSlot>,
      ): Promise<string> => {
        const start = Date.now();
        const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            ...slotToBody(sampling),
          }),
        });
        if (!resp.ok) {
          throw new Error(`LLM API error ${resp.status}: ${await resp.text().catch(() => '')}`);
        }
        const data = await resp.json() as any;
        const content: string = data?.choices?.[0]?.message?.content || '';

        // ★ 2026-10-11（instrument-memory-llm）：记忆链路是**独立于 OpenAIProvider 的
        //   第二个 LLM 客户端**（故意绕开 ProviderManager 直连 fetch，见上方注释）。
        //   此前它一条日志都不打，于是会话摘要 / 画像提取 / cron 深度重写 / 人格调整
        //   这四个槽位的失败**恰好落在观测盲区**——线上 8 天 10 次「空响应」+ 4 次
        //   `truncated=true` 全都看不到 finish_reason，无法按 spec §4.1.2 契约 4 判定。
        //   这里补齐与 `provider/openai.ts` 同款的预算现场；日志标签刻意用
        //   `[LLM:memory]` 与聊天链路的 `[LLM]` 区分（两者失败处置不同）。
        const finishReason: string | undefined = data?.choices?.[0]?.finish_reason ?? undefined;
        const reasoningTokens: number | undefined =
          data?.usage?.completion_tokens_details?.reasoning_tokens ?? undefined;
        const usage = data?.usage;
        const tokenStr = usage
          ? `${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}`
          : '?';

        log.info(
          `[LLM:memory] ${cfg.model} → ${content.slice(0, 80).replace(/\n/g, ' ')}` +
          ` tokens=${tokenStr} finish=${finishReason ?? '?'} reasoning=${reasoningTokens ?? '?'}` +
          ` (${Date.now() - start}ms)`
        );

        // ★ 空响应要单独可见（spec §4.1.3 契约 5）："没内容"与"预算被推理吃光"
        //   此前在日志里长得一样，而后者有完全不同的处置（该槽要更大的 max_tokens）。
        if (!content) {
          log.warn(
            `[LLM:memory] ${cfg.model} returned EMPTY content — finish=${finishReason ?? '?'}` +
            ` tokens=${tokenStr} reasoning=${reasoningTokens ?? '?'}` +
            (finishReason === 'length'
              ? ' → max_tokens 预算耗尽（推理吃光），该槽位需要更大的 max_tokens'
              : ' → 不是预算问题（finish≠length），需另查')
          );
        }

        return content;
      },
    });
  },
};
