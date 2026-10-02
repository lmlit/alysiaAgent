// src/utils/write-trace.ts
import { logger } from './logger.js';

/**
 * 写入影响行数观测 —— **只观测，不拦截**。
 *
 * ★ 2026-10-02（change: observe-zero-row-writes）
 *
 * 背景（`docs/KNOWN-ISSUES.md` KI-11）：全 core 55 个写入点里只有 3 处检查了
 * `.run()` 返回的 `changes`。`UPDATE … WHERE id = ?` 命中 0 行**不报错** ——
 * 「改到了」与「什么都没改」完全同形。这是本项目栽过三次的
 * 「**空转伪装成归档**」的产地。
 *
 * **为什么不直接硬校验**：`changes === 0` 有两种含义，静态分不出来 ——
 *   - **正常**：幂等跳过（`INSERT OR IGNORE` 遇到已存在的行）
 *   - **异常**：目标行不存在（写错 id / 行被并发删除 / **表结构不对，列没迁上**）
 * 一刀切会把正常路径变成噪声，比现在更糟。
 *
 * **所以先收集分布**：跑一段时间后按 tag grep `[WriteTrace]` 统计各写点的
 * 「0 行发生率」，再逐点决定「必须硬校验」还是「显式豁免」。
 * 这与 KI-1 的处理方式同构：**先取证据，再改代码**。
 *
 * ⚠️ **用 `warn` 不用 `debug`**：`debug` 被 `ALYSIA_DEBUG` 门控、产线不输出
 * （`LifeStore` 唯一那行日志就是这么变成"等于没有"的）。
 */
export function traceZeroRows(tag: string, changes: number, context?: string): void {
  if (changes !== 0) return;
  logger.warn(
    `[WriteTrace] ${tag} 命中 0 行${context ? ` — ${context}` : ''}（观测中，勿据此报错；决策见 KI-11）`,
  );
}
