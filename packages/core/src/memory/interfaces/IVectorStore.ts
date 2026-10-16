// src/memory/interfaces/IVectorStore.ts
import type { SearchResult } from '../types.js';

/**
 * 向量库抽象。
 *
 * ## 失败契约（★ 2026-10-16，change: `fix-store-write-trace`，KI-14 / KI-15）
 *
 * **实现必须把失败报出来，不许自己吞掉。** 具体：
 *
 * | 方法 | 成功 | 失败 |
 * |---|---|---|
 * | `insert` / `delete` | resolve | **reject**（写没写进去必须可判） |
 * | `search` | 结果数组，**`[]` 表示确实没有匹配** | **reject**（不许用 `[]` 冒充故障） |
 * | `count` | 条数 | **reject**（不许用 `0` 冒充「库是空的」） |
 *
 * 「不可用」（没装 / 打不开）**也是失败**，用 `VectorStoreUnavailableError` 区分，
 * 让调用方能选择**降级**（退到文本检索）而不是以为「写成功了 / 没匹配到」。
 *
 * 为什么这么严：旧的 `LanceDBStore` 把四类失败全吞了，后果是**层层伪装**——
 *   ① 上游每一处 `try { insert } catch { warn }` 都成了**死代码**（真实 store 永不抛），
 *      2026-09-27 的回填脚本 `done++` 计的就是「没抛异常」，一条向量没写也照样打全绿；
 *   ② `search` 的「故障」与「无匹配」同形 ⇒ 文本降级永不触发；
 *   ③ `count` 的「读不了」与「空库」同形 ⇒ 它没法当健康检查判据。
 *
 * 「降级」是**调用方的决定**（它才知道该不该退到文本检索），不是实现的擅自省略。
 */
export interface IVectorStore {
  insert(id: string, vector: number[], text: string, metadata: Record<string, unknown>): Promise<void>;
  search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<SearchResult[]>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}
