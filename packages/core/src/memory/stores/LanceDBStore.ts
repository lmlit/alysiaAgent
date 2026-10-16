// src/memory/stores/LanceDBStore.ts
// Concrete IVectorStore backed by LanceDB (embedded vector database).
// On initialization failure, the caller should discard this instance —
// MemoryManager will fall back to SQLite text search automatically.

import type { IVectorStore } from '../interfaces/IVectorStore.js';
import type { SearchResult } from '../types.js';
import { logger } from '../../utils/logger.js';

/** Escape a string value for use in LanceDB SQL predicate (double-quote escaping). */
function esc(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

/** Safe JSON parse with default. */
function safeJsonParse(s: string | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * 向量库**不可用**（没装 / 打不开 / 初始化失败）——
 * 与「单次操作失败」区分开，让调用方能判该不该降级。
 *
 * ★ 2026-10-16（change: `fix-store-write-trace`，KI-14）：
 *   旧实现遇到这种情况**静默 return**（insert 当成功、search 当无匹配、count 当空库），
 *   于是「向量库根本没起来」在整条链路上**不留任何痕**。
 */
export class VectorStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`向量库不可用：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'VectorStoreUnavailableError';
  }
}

/**
 * LanceDB-backed vector store.
 *
 * Table schema (auto-inferred from initial row):
 *   id           — string (primary identifier)
 *   vector       — fixed_size_list<float>[dimension]
 *   text         — string (original text)
 *   source       — string ('event' | 'conversation' | 'knowledge')
 *   metadata_json — string (JSON-serialized metadata)
 */
export class LanceDBStore implements IVectorStore {
  private db: any = null;
  private table: any = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    private dbPath: string,
    private tableName: string = 'vectors',
    private dimension: number = 1024,
  ) {}

  /** One-shot async init. Idempotent — subsequent calls return the same promise. */
  async initialize(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit();
    return this.initPromise;
  }

  /**
   * 释放句柄（**停机用**）。幂等；调用后本实例不可再用（各方法会抛
   * `VectorStoreUnavailableError`，因为 `ready` 已复位）。
   *
   * ★ 2026-10-16（change: `unify-core-shutdown`）：`core.stop()` 此前**不释放** LanceDB，
   *   Windows 上临时目录因此删不掉（`EPERM`）。
   *
   * ✅ **验收已达成**（2026-10-16，真实 e2e，Windows）：实现里这里只是**放掉本包装
   *   持有的引用**（LanceDB 是 napi 绑定，没有明确的 close 原语），但实测这**足够**——
   *   `tests/memory/e2e/core-turn.test.ts` 的 `afterAll` 已把「`stop()` 后临时目录必须能删掉」
   *   收紧为**硬断言**，实测残留 **0 个**目录、用例通过。
   *   ⚠️ 这不等于「原生侧句柄被确定性释放」（那要看 GC 时机），
   *      只等于**Windows 文件锁已放开到能删除**——而那正是当初的问题。
   */
  close(): void {
    this.table = null;
    this.db = null;
    this.ready = false;
    this.initPromise = null;
  }

  private async _doInit(): Promise<void> {
    const lancedb = await import('@lancedb/lancedb');
    this.db = await lancedb.connect(this.dbPath);

    // Open existing table or create a new one with auto-inferred schema
    try {
      this.table = await this.db.openTable(this.tableName);
      logger.info(`[LanceDB] opened table "${this.tableName}" at ${this.dbPath}`);
    } catch (openErr: any) {
      // ★ KI-5：原来是裸 catch —— **所有** openTable 失败都被当作「表不存在」，
      //   于是后面那句 warn 里的报错是**误导性的**（真原因被丢掉）。
      //   这里把真原因带出来（info 级：这是预期内的首次建表路径），
      //   若随后 createTable 也失败，异常会继续往上抛成 `VectorStoreUnavailableError`。
      logger.info(
        `[LanceDB] openTable 失败，按「表不存在」处理并建表` +
        `（table=${this.tableName}）: ${openErr?.message ?? openErr}`,
      );
      // Table doesn't exist — create with a placeholder row to infer schema
      const emptyVector = new Array(this.dimension).fill(0);
      this.table = await this.db.createTable(this.tableName, [{
        id: '__init__',
        vector: emptyVector,
        text: '',
        source: 'event',
        metadata_json: '{}',
      }]);
      // Remove placeholder row
      await this.table.delete('id = "__init__"');
      logger.info(`[LanceDB] created table "${this.tableName}" (dim=${this.dimension}) at ${this.dbPath}`);
    }

    this.ready = true;
  }

  /**
   * 确认 store 可用；**不可用就抛** `VectorStoreUnavailableError`（不再静默 return）。
   *
   * ★ KI-14：旧实现叫 `ensureReady()`，返回 `false` 后各方法静默降级 ——
   *   「库没起来」被伪装成「写成功了 / 没匹配到 / 库是空的」。
   *   现在降级必须由**调用方显式决定**（它才知道该不该退到文本检索）。
   */
  private async requireReady(): Promise<void> {
    if (this.ready) return;
    try {
      await this.initialize();
    } catch (err: any) {
      logger.warn(`[LanceDB] 不可用: ${err?.message ?? err}`);
      throw new VectorStoreUnavailableError(err);
    }
    if (!this.ready) throw new VectorStoreUnavailableError('初始化完成但未就绪');
  }

  // ── IVectorStore ────────────────────────────────────────

  /**
   * 写入一条向量。**失败会抛**（KI-14）。
   *
   * 契约（`memory-system` §4.7）：失败**必须**让调用方能判 ——
   * 调用方有 try/catch 就自己降级并留痕；没有就让它冒上去。
   * 「静默 warn + 假装成功」是最坏的一种：上游那些 catch 会全部变成**死代码**
   * （2026-09-27 回填脚本 `done++` 计的就是「没抛异常」，一条向量都没写也照样打全绿）。
   */
  async insert(id: string, vector: number[], text: string, metadata: Record<string, unknown>): Promise<void> {
    await this.requireReady();
    // Upsert: delete any existing row with same id, then add
    const safeId = id.replace(/"/g, '""');
    try {
      await this.table.delete(`id = "${safeId}"`);
    } catch (err: any) {
      // ★ 这一处**不抛**（KI-5 那条）：LanceDB 的 delete 在「谓词没匹配到」时是否抛
      //   无法在本仓证实，直接抛会把每次正常写入都变成失败。但**必须留痕** ——
      //   删旧行真失败会让**同 id 两条向量并存** → 召回里同一条记忆重复出现，且无痕。
      logger.warn(
        `[LanceDB] upsert 前置删除失败（可能留下同 id 重复行）(id=${id.slice(0, 30)}): ${err?.message ?? err}`,
      );
    }
    try {
      await this.table.add([{
        id,
        vector,
        text,
        source: (metadata.source as string) || 'event',
        metadata_json: JSON.stringify(metadata),
      }]);
    } catch (err: any) {
      logger.warn(`[LanceDB] insert failed (id=${id.slice(0, 30)}): ${err?.message ?? err}`);
      throw err;
    }
  }

  /**
   * 向量检索。**故障会抛**（KI-14）：返回 `[]` 只表示「检索成功但没有匹配」。
   *
   * 旧实现把两种含义都压成 `[]`，于是上层**分不出**「没有相关记忆」与
   * 「向量库挂了」——而两者的正确处置完全不同（前者正常，后者必须降级到文本检索并留痕）。
   */
  async search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<SearchResult[]> {
    await this.requireReady();
    try {
      // ★ 9-25 optimize-recall-pipeline：显式用**余弦距离**（默认是 L2）。
      //
      //   原来用 L2 + `score = 1 - d` 是错的：单位向量下 L2 = √(2−2cos)，
      //   于是 d=1（cos 仍有 0.5，明显相关）时 score 就被 clamp 成 0 ——
      //   可用区间被砍掉一半，实测导致"长文本来源"（会话摘要/生活事件）分数全塌成 0、
      //   全局排序失效、被合并顺序系统性饿死（46 条 life_event 一条都进不了最终 5 条）。
      //
      //   换 cosine 后 `1 - _distance` 直接就是余弦相似度，全区间有分辨力（实测
      //   同一查询：L2 下 d=1.004 → 0.000，cosine 下 → 0.496）。
      //
      //   ⚠️ 若将来给本表建向量索引，索引训练用的距离度量必须也是 cosine，
      //      否则结果无效（LanceDB 明确要求二者一致）。当前表无索引（暴力扫描），可自由选。
      let query = this.table.vectorSearch(vector).distanceType('cosine').limit(topK);

      // Apply optional source filter (e.g. { source: 'knowledge' })
      if (filter?.source && typeof filter.source === 'string') {
        query = query.where(`source = ${esc(filter.source)}`);
      }

      const rows = await query.toArray() as Array<Record<string, unknown>>;
      return rows
        .filter(r => r.id !== '__init__')
        .map(r => ({
          id: r.id as string,
          // _distance 现在是**余弦距离**（1 − cos，∈[0,2]，越小越相似），
          // 所以 `1 − d` 即余弦相似度。理论上限 2 会给出负值，clamp 到 0。
          score: r._distance != null ? Math.max(0, 1 - (r._distance as number)) : 0.5,
          text: r.text as string,
          metadata: safeJsonParse(r.metadata_json as string | undefined, {}),
        }));
    } catch (err: any) {
      // ★ KI-14：不再 `return []` —— 否则「故障」与「无匹配」同形，
      //   上层也就永远不会触发文本降级（契约见 `memory-system` §4.7）。
      logger.warn(`[LanceDB] search failed: ${err?.message ?? err}`);
      throw err;
    }
  }

  /** 删除一条向量。**失败会抛**（KI-14）——删除失败留下的孤儿向量仍会被召回。 */
  async delete(id: string): Promise<void> {
    await this.requireReady();
    try {
      const safeId = id.replace(/"/g, '""');
      await this.table.delete(`id = "${safeId}"`);
    } catch (err: any) {
      logger.warn(`[LanceDB] delete failed (id=${id.slice(0, 30)}): ${err?.message ?? err}`);
      throw err;
    }
  }

  /**
   * 向量条数。**失败会抛**（KI-14）：旧实现 `catch { return 0 }` 让
   * 「库是空的」与「库读不了」完全同形 —— 它本该是健康检查的判据（KI-15）。
   */
  async count(): Promise<number> {
    await this.requireReady();
    try {
      return await this.table.countRows() as number;
    } catch (err: any) {
      logger.warn(`[LanceDB] count failed: ${err?.message ?? err}`);
      throw err;
    }
  }
}
