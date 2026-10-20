/**
 * 基础资源模块 —— `AlysiaCore.start()` 的第 1-5 步（change: modularize-core-assembly）。
 *
 * 这一层**不认识 alysia 的业务**，只把外部资源（SQLite / LanceDB / 两个 HTTP 服务）
 * 变成内核里的服务。上层 `al:memory` 只认服务名，不认它们怎么建的。
 */

import { initializeDatabase } from '../memory/database.js';
// ★ 2026-10-20（change: unify-memory-llm-client；KI-3 + KI-9）：记忆链路只有**一个**实现
import { MemoryLlmClient } from '../memory/services/MemoryLlmClient.js';
import type { MemoryLlmProvider } from '../memory/services/MemoryLlmClient.js';
import type { Module } from '../kernel/index.js';

// ── al:db ─────────────────────────────────────────────────────

export interface DbConfig {
  /** SQLite 文件路径 */
  path: string;
}

/**
 * better-sqlite3（WAL）。对应 `index.ts:103-106`。
 *
 * ★ 2026-10-16（change: `unify-core-shutdown` 的落地）：**停机时关掉句柄**。
 *
 * 顺序**由内核保证、不需要在这里排**：`al:db` 是**第一个装**的模块，
 * 而卸载是**严格逆序** ⇒ 它**最后一个卸**。此刻 `al:memory` / `al:tools` /
 * `al:commands` / 各 processor 都已卸完，不会再有它们发起的写入。
 *
 * ⚠️ **这是行为变更**：`stop()` 之后任何写入/读取都会**抛错**
 * （better-sqlite3：「The database connection is not open」）而不是静默成功 ——
 * 这正是我们要的「关太早必须响亮」，但调用方若假设「stop 之后还能用」就会开始失败。
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

    // 不 catch：关闭失败交给内核的统一清理路径（`disposeEntry` 会 logger.error
    // 并继续清理其余模块），避免这里再长出一套错误语义。
    ctx.effect(() => () => {
      db.close();
      ctx.logger.info('[al:db] 已关闭 SQLite 句柄（停机）');
    }, 'al:db.close');
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
      // ★ 2026-10-16（unify-core-shutdown）：停机时释放句柄（只在**真的建起来**时注册，
      //   降级路径给的是 `null`，没有东西可关）。
      //   ⚠️ LanceDB 是 napi 绑定，**没有确定性释放**（不像 better-sqlite3 的 `close()`）；
      //      `LanceDBStore.close()` 只能放掉本包装持有的引用。Windows 上目录能否立刻删除
      //      **未在本机验证**（需真实 e2e）——见该方法的注释。
      ctx.effect(() => () => {
        store.close();
        ctx.logger.info('[al:vector] 已释放 LanceDB 句柄（停机，尽力而为）');
      }, 'al:vector.close');
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
  /**
   * ★ 2026-10-20（change: `let-memory-use-provider`）：记忆链路是否经 `ProviderManager`。
   *
   * 缺省 `false`（= 直连 fetch，**行为不变**）。打开可拿到 fallback；
   * 代价与前提见 `memoryLlmModule` 的注释与 `memory-system` §4.1.4 契约 7.5。
   */
  viaProvider?: boolean;
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
        /**
         * ★ 2026-10-19（change: `fix-empty-embed-query`）：空文本**不发请求**。
         *
         * 智谱对空 prompt 回 `400 {"code":"1213","message":"未正常接收到prompt参数。"}` ——
         * 既浪费一次往返，又把一条 400 写进日志（真故障会被它淹掉）。
         * 空文本在语义上就没有向量；调用方本该跳过（`MemoryManager.read` 已加守卫）。
         * 这里抛明确的错误，方便定位"谁在拿空文本要向量"。
         */
        if (!text || text.trim() === '') {
          throw new Error('embed: 空文本（调用方应在调用前跳过 embedding）');
        }
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
 * 记忆系统专用 LLM 客户端（画像提取 / 会话摘要 / cron 深度重写 / 人格调整）。
 *
 * ★ 2026-10-20（change: unify-memory-llm-client；KI-3 + KI-9）：
 *   这里原先是一段**内联对象字面量**，与 `memory/services/OpenAILLMService.ts` 构成
 *   两套实现 —— 而 E2E 测的是后者，后者**既没有超时也没有观测**。现在两者共用
 *   `MemoryLlmClient`：实现只有一个，request body 一致由契约测试锁住。
 *
 * ★ 2026-10-20（change: let-memory-use-provider）：**收编能力已就位，默认不开**。
 *
 *   `cfg.viaProvider === true` 时才经 `ProviderManager.textChatWithFallback`（拿到 fallback
 *   与统一 provider 观测）；否则维持原来的**直连 fetch**。
 *
 *   **为什么默认关**（不是没做完，是代价明确）：
 *   1. **今天只有一个 provider** ⇒ fallback 实际空转，收益为零；
 *   2. 走 provider 会多打一行 `[LLM]`，而 `memory-system` §4.1.3 契约 5 钉的是
 *      `[LLM:memory]` 这个标签 —— 两行并存会让 token 统计**重复计数**；
 *   3. 错误文案由 provider 生成，本类负责翻译回契约 6.2 / 7.4 的格式（已在
 *      `completeViaProvider` 里实现并有测试），但这层翻译是新的失败面。
 *
 *   打开条件（写进 spec 契约 7.5）：**注册了 ≥2 个 provider**（fallback 才有意义），
 *   且接受 `[LLM]` + `[LLM:memory]` 两行日志。回滚只需把 `viaProvider` 设回 false。
 */
export const memoryLlmModule: Module<HttpEndpointConfig> = {
  name: 'al:memory-llm',
  apply(ctx, config) {
    const cfg = config!;
    ctx.provide(
      'al:memory-llm',
      new MemoryLlmClient(
        { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
        {
          // 用 `ctx.logger`（生产环境 = `utils/logger` 的同一对象，见 `kernel/host.ts:37`）——
          // 这样观测是可断言的：`tests/modules/helpers.ts` 的 runModule 注入测试 logger。
          logger: ctx.logger,
          // 懒取：装配顺序无关（`al:memory-llm` 与 `al:provider` 没有依赖边），
          // 未启用时连一次 `ctx.get` 都不会发生
          providerRef: cfg.viaProvider ? () => ctx.get<MemoryLlmProvider>('al:provider') : undefined,
        },
      ),
    );
  },
};
