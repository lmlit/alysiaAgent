/**
 * 记忆重要性（importance）计算
 * ★ 9-25 change: wire-importance-signal
 *
 * 背景：`events.importance` 列从建表起就存在、`EventStore` 也读写它、
 * `applyKnobsToRetrieved` 更有 `importance > 阈值 → +0.15` 的分支 ——
 * 但**四条写入路径没有一条写入有效值**，该分支从未执行。
 * 代码里留着明确的 TODO（`MemoryManager.ts:846` / `ProfileExtractor.ts:48`）。
 *
 * 本模块提供「生活事件」那一路的算法（对话消息那一路由 SessionEndProcessor 的
 * LLM 顺带打分，见该文件）。
 *
 * ★ 用户拍板的信号（2026-09-25）：**情绪强度** —— 贴合 soul.md 里
 *   "三千万世的人对什么记忆更深" 的设定。
 */

/**
 * ★ 下面四个系数是**启发式**，不是从数据推出来的。
 *   全部提成具名常量便于调参；调整前先用
 *   `scripts/recall-probe.ts` 看实际分布。
 */

/** 基线：每条生活事件都有基本分量 —— 她确实过了这段日子 */
export const LIFE_BASE = 0.3;
/** 情绪加成上限 */
export const LIFE_EMOTION_MAX = 0.4;
/** 对话余波折减：她自己过日子的分量 > 接你的话 */
export const FOLLOWUP_FACTOR = 0.8;

/**
 * 情绪词 → 强度 0~1。
 *
 * ★ 取的是 **arousal（唤醒度）而非 valence（正负）** ——
 *   "平静" 与 "雀跃" 的差别是强度，不是好坏；
 *   负面情绪（难过/生气）同样值得记住，所以也映射成高值。
 */
const MOOD_WORD_INTENSITY: Record<string, number> = {
  // 低唤醒
  平静: 0.15, 安静: 0.15, 慵懒: 0.2, 淡淡的: 0.2, 放空: 0.2,
  // 中低
  安心: 0.4, 温柔: 0.5, 温暖: 0.5, warm: 0.5, 舒缓: 0.4,
  // 中高
  低落: 0.6, 失落: 0.6, 担心: 0.6, 热闹: 0.7,
  // 高唤醒（正负都算）
  开心: 0.75, 高兴: 0.75, 兴奋: 0.9, 雀跃: 0.9, 生气: 0.85, 难过: 0.8,
};

/** 词表未收录时的强度（不判 0 —— 有情绪标记本身就有信息） */
const MOOD_WORD_FALLBACK = 0.5;

/**
 * 把 `mood_delta` 归一成情绪强度 0~1。
 *
 * ★ 真实数据很乱（实测分布）：`+1`(51) / `平静`(37) / `+0.01`(28) / `+0.1`(14) /
 *   `+2`(5) / `+0.001`(5) / `warm`(2) —— **数字尺度差三个数量级，还混着情绪词**。
 *
 *   所以这里**不做尺度校准**（无基准可比），只把数值取绝对值后截到 1：
 *   `+0.001` 与 `+1` 确实可能都是"略正向"的不同写法，但猜不出换算关系，
 *   就按字面量对待 —— 与其编一个校准曲线，不如承认数据本身不可靠。
 *   真正弥补它的是 {@link LIFE_BASE} 基线（不靠情绪也有 0.3 分）。
 */
export function moodDeltaToIntensity(raw: string | null | undefined): number {
  const s = String(raw ?? '').trim();
  if (!s) return 0;

  const n = Number(s.replace(/^\+/, ''));
  if (Number.isFinite(n)) return Math.min(1, Math.abs(n));

  const exact = MOOD_WORD_INTENSITY[s];
  if (exact !== undefined) return exact;

  // 子串匹配（"有点开心" 命中 "开心"）——按强度降序找，避免短词抢先命中
  const hit = Object.entries(MOOD_WORD_INTENSITY)
    .sort((a, b) => b[1] - a[1])
    .find(([word]) => s.includes(word));
  return hit ? hit[1] : MOOD_WORD_FALLBACK;
}

/**
 * 生活事件的 importance = 基线 + 情绪加成（对话余波再折减）。
 *
 * 区间约 0.24 ~ 0.7，而 `importance_threshold` 默认 **0.4** ——
 * 有情绪波动的过线、平静的不过线，**有区分度**（这正是接线前缺的东西）。
 */
export function lifeEventImportance(input: {
  moodDelta?: string | null;
  origin?: string;
}): number {
  const base = LIFE_BASE;
  const bonus = moodDeltaToIntensity(input.moodDelta) * LIFE_EMOTION_MAX;
  const factor = input.origin === 'followup' ? FOLLOWUP_FACTOR : 1;
  const v = Math.min(1, Math.max(0, (base + bonus) * factor));
  return Math.round(v * 1000) / 1000; // 收敛浮点噪声，便于比较与日志
}
