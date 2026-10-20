// src/memory/engines/PersonaAdapter.ts
import type { MemoryEvent, PersonaAdjustment } from '../types.js';
// ★ 2026-10-20（change: `fix-memory-knob-regression`）：记忆旋钮的回归目标要用**各自的默认值**
import { DEFAULT_MEMORY_CONFIG } from '../types.js';
import { PersonaStore } from '../stores/PersonaStore.js';
import type { ILLMService } from '../interfaces/ILLMService.js';
import { logger } from '../../utils/logger.js';
// ★ KI-4：共用解析器（与 ProfileExtractor / SessionEndProcessor 同一套判据）
import { parseLLMJson } from '../../utils/llm-json.js';
import { warnThrottled } from '../../utils/write-trace.js';
// ★ add-memory-channel-field：hint 条目的渠道（穿参下来，不默认 unknown）
import type { MemoryChannel } from '../../utils/channel.js';

const MAX_DELTA = 0.1;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONSECUTIVE_SAME_DIRECTION = 3;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const REGRESSION_AMOUNT = 0.05;

/**
 * ★ 2026-10-20（change: `fix-memory-knob-regression`）：记忆旋钮的**各自值域**。
 *
 * 为什么不能统一 `clamp(-1, 1)`：`decay_rate` / `importance_threshold` /
 * `recency_weight` / `confirmation_bias` 的语义域都是 **0..1**（"0=不忘"这种），
 * 负值无定义；只有 `retention_bias` 是双向的（-1 记得坏 / +1 记得好）。
 */
const MEMORY_KNOB_BOUNDS: Record<string, [number, number]> = {
  retention_bias: [-1, 1],
  decay_rate: [0, 1],
  importance_threshold: [0, 1],
  recency_weight: [0, 1],
  confirmation_bias: [0, 1],
};
const EXPLICIT_PATTERN = /不要|别|不许|不可以|必须|以后都|千万别|请务必|我叫|叫我/;

export class PersonaAdapter {
  private lastAdjustmentTime = new Map<string, number>();
  private consecutiveDirection = new Map<string, { direction: number; count: number }>();
  private applyLock = false;
  private lastSignalProcessed = 0; // 全局冷却：避免短时间内重复调 LLM

  constructor(private store: PersonaStore, private llm: ILLMService) {}

  async processSignal(event: MemoryEvent): Promise<PersonaAdjustment | null> {
    const content = (event.payload.content as string) || '';

    // Check for explicit user directives (stronger signal — bypasses all limits)
    const isExplicit = EXPLICIT_PATTERN.test(content);

    // Check for regular preference signals
    const hasPreferenceSignal = /太+|能不能别|我喜欢|我讨厌|不要|别|更|再/.test(content);
    if (!hasPreferenceSignal && !isExplicit) return null;

    // ★ 冷却检查前置：全局 2 分钟内不再调 LLM（显式指令除外）
    if (!isExplicit && Date.now() - this.lastSignalProcessed < 2 * 60_000) {
      return null;
    }

    // Ask LLM to determine adjustment (v2: 包含 memory_config)
    const persona = this.store.get();
    const memoryConfig = this.store.getMemoryConfig();
    // ★ 8-28 retention_bias 语义转向角色性格（memory-character-perspective）：不再是"偏好讨好用户"，
    //   而是"昔涟作为三千万世的人对什么记忆更深"——负=刻骨铭心的事记得深，正=温暖明亮的时刻记得深
    const prompt = `当前人格参数: ${JSON.stringify({
      tone: JSON.parse(persona.tone),
      speech: JSON.parse(persona.speech_style),
      emotional: JSON.parse(persona.emotional_range),
      memory: memoryConfig,
    })}\n用户消息: "${content}"\n判断是否需要调整。记忆旋钮(memory): retention_bias(-1=作为三千万世轮回者对伤痛/遗憾记得更深,+1=对温暖明亮的时刻记得更深,这是她的性格不是讨好倾向), decay_rate(0=不忘,1=秒忘), importance_threshold(0=什么都记,1=只记大事), recency_weight(0=念旧,1=只认最近), confirmation_bias(0=随风倒,1=固执)。返回JSON: {"adjustments": [{"param": "...", "delta": 0.0, "reason": "..."}]}`;

    this.lastSignalProcessed = Date.now();

    const response = await this.llm.complete(
      '你是人格参数调节器。根据用户反馈判断人格参数和记忆偏好是否需要微调。delta范围[-0.1, 0.1]。',
      prompt
    );

    try {
      // ★ 2026-10-16（change: `fix-persona-adapter-json-tolerance`，KI-4）：
      //   改用**共用解析器**（剥 markdown 围栏 + 空判 + 裸文本分类），不再裸 `JSON.parse`。
      //
      //   为什么必须换：模型即使被要求"只输出 JSON"，也常包一层 ```json。
      //   裸 parse 遇到围栏直接抛，而这里原来 catch 后只写一句注释就放弃（**无日志**）
      //   ⇒ **人格自适应静默失效**：没有人格调整，也没有任何痕迹，
      //     看起来和"这轮确实不需要调整"一模一样。
      //
      //   ⚠️ 这个坑项目里**已经修过一次**（见 `utils/llm-json.ts` 头注：
      //     "这个需求出现了两次——只做对了一处。线上后果：会话摘要 22 天 100% 失败"）。
      //     `ProfileExtractor` / `SessionEndProcessor` 当时都换了，
      //     **只有这里还留着裸写法** —— 本 change 把它对齐，判据不再分叉。
      const parsedResult = parseLLMJson(response);

      if (parsedResult.kind !== 'json') {
        // 「模型说了句人话」与「话说到一半被掐了」策略不同，但**都必须留痕** ——
        // 静默正是 KI-4 藏了这么久的原因。限频：人格扫描是**每条用户消息**都走的路径。
        warnThrottled(
          'persona-adapter-json',
          `[PersonaAdapter] LLM 未返回可解析的 JSON（kind=${parsedResult.kind}` +
            `${parsedResult.kind === 'bare' && parsedResult.truncated ? ', 疑似被截断' : ''}）` +
            `—— 本次人格调整**跳过**（不是"不需要调整"）`,
        );
        return null;
      }

      const parsed = parsedResult.value;
      if (parsed.adjustments && parsed.adjustments.length > 0) {
        const adj = parsed.adjustments[0];
        // Validate required fields exist before using them
        if (typeof adj.param !== 'string' || typeof adj.delta !== 'number') {
          return null;
        }
        return {
          param: adj.param,
          delta: adj.delta,
          reason: adj.reason || '',
          ...(isExplicit ? { explicit: true } : {}),
        };
      }
    } catch (err: any) {
      // 走到这里说明是**解析成功但结构不对**（如 adjustments 不是数组）——
      // 与上面那类"解析不出来"不同，但也**不该静默**（限频）。
      warnThrottled(
        'persona-adapter-shape',
        `[PersonaAdapter] LLM 返回的 JSON 结构异常：${err?.message ?? err}`,
      );
    }
    return null;
  }

  /** ★ 8-28 情绪惯性漂移（memory-character-perspective）：生活事件累积 mood_value 驱动自然漂移——
   *  连续开心（moodValue≥15）→ playfulness 微升；连续低落（≤-15）→ empathy 微升。
   *  走 apply 5 道护栏（Δ 钳制/冷却/同向次数/24h 回归）；24h 回归把参数拉回默认，不会无限累积。 */
  adjustFromMood(moodValue: number): boolean {
    if (moodValue >= 15) {
      return this.apply({ param: 'emotional_range.playfulness', delta: 0.05, reason: '情绪惯性：连续开心，自然更活泼' }, { channel: 'life' });
    }
    if (moodValue <= -15) {
      return this.apply({ param: 'emotional_range.empathy', delta: 0.05, reason: '情绪惯性：连续低落，变得更敏感共情' }, { channel: 'life' });
    }
    return false;
  }

  apply(adjustment: PersonaAdjustment, options?: { bypassLimits?: boolean; channel?: MemoryChannel }): boolean {
    // Prevent concurrent apply() calls from racing on Maps
    if (this.applyLock) return false;
    this.applyLock = true;
    try {
      return this._applyLocked(adjustment, options);
    } finally {
      this.applyLock = false;
    }
  }

  private _applyLocked(adjustment: PersonaAdjustment, options?: { bypassLimits?: boolean; channel?: MemoryChannel }): boolean {
    const bypass = adjustment.explicit || options?.bypassLimits || false;

    // Regress stale params toward default before processing new adjustment
    this.regressIfStale();

    // Clamp delta (skipped in bypass mode — the user's explicit directive takes precedence)
    const clampedDelta = bypass
      ? adjustment.delta
      : Math.max(-MAX_DELTA, Math.min(MAX_DELTA, adjustment.delta));

    if (!bypass) {
      // Cooldown check
      const now = Date.now();
      const lastTime = this.lastAdjustmentTime.get(adjustment.param) || 0;
      if (now - lastTime < COOLDOWN_MS) return false;

      // Consecutive direction check
      const dir = this.consecutiveDirection.get(adjustment.param) || { direction: 0, count: 0 };
      const newDirection = clampedDelta > 0 ? 1 : clampedDelta < 0 ? -1 : 0;
      if (newDirection !== 0 && newDirection === dir.direction) {
        if (dir.count >= MAX_CONSECUTIVE_SAME_DIRECTION) return false;
        dir.count++;
      } else {
        dir.direction = newDirection;
        dir.count = 1;
      }
      this.consecutiveDirection.set(adjustment.param, dir);
      // ★ 8-29 Overlay 固化（persona-overlay-perspective）：同向调整 ≥3 次 → 稳定演化备注
      //   （HDSI Overlay：达到证据门槛的稳定变化才固化，单次反馈不固化）
      if (dir.count >= 3 && dir.count % 3 === 0) {
        this.freezeOverlayNote(adjustment.param, newDirection, dir.count);
      }
    }

    // Apply to correct dimension (final value still clamped to [-1, 1])
    this.applyToParam(adjustment.param, clampedDelta);

    // Record
    if (!bypass) {
      this.lastAdjustmentTime.set(adjustment.param, Date.now());
    }
    this.store.addAdaptationHint({
      trigger: bypass ? 'explicit_directive' : 'auto_adapt',
      adjustment: { [adjustment.param]: clampedDelta },
      evidence: adjustment.reason,
      applied_at: new Date().toISOString(),
      // ★ add-memory-channel-field：**穿参**下来的渠道（调用方有事件上下文，能如实给）
      channel: options?.channel ?? 'unknown',
    });

    return true;
  }

  /** ★ 8-29 Overlay 固化备注：同向调整 ≥3 次 → 写入 overlay_notes（稳定演化，注入 prompt） */
  private freezeOverlayNote(param: string, direction: number, count: number): void {
    try {
      const dimension = param.split('.')[1] ?? param;
      const change = direction > 0 ? '更' + dimension : '更收敛/更内敛';
      this.store.appendOverlayNote({
        dimension: param,
        change,
        evidence: `最近 ${count} 次同向调整`,
        appliedAt: new Date().toISOString(),
      });
      logger.info(`[Persona] overlay frozen: ${param} ${direction > 0 ? '↑' : '↓'} (evidence: ${count} same-direction)`);
    } catch (err: any) {
      logger.warn(`[Persona] overlay freeze failed: ${err.message}`);
    }
  }

  /**
   * Regress persona params that haven't been adjusted in 24+ hours back toward **default**.
   * Each stale param moves 0.05 toward the default, without overshooting.
   * ★ 8-29 Overlay 豁免：已固化的参数（overlay_notes 有记录）不再回归——稳定演化保留。
   *
   * ★ 2026-10-20（change: `fix-memory-knob-regression`；B4）—— **记忆旋钮的回归目标是错的**：
   *
   *   旧实现一律「回归到 0」，但记忆旋钮的**默认值不是 0**（`DEFAULT_MEMORY_CONFIG`：
   *   `decay_rate 0.3` / `importance_threshold 0.4` / `retention_bias 0.2` / …）。
   *   于是"24 小时后回到默认"实际变成了**把旋钮推向极端**：
   *     - `decay_rate → 0` = **永不遗忘**（语义是"0=不忘"）
   *     - `importance_threshold → 0` = **什么都记**（"只记大事"的反面）
   *     - `retention_bias → 0` = 不再有任何偏向（而她的默认是"微微偏向正面"）
   *
   *   这不是"回归"，是**单向漂移**：每次 stale 都往极端挪 0.05，且**没有界线**。
   *   修法：记忆旋钮回归到 `DEFAULT_MEMORY_CONFIG` 的对应值（分段：按数值维护，
   *   而不是按 "0" 这个字面量）。
   */
  private regressIfStale(): void {
    const now = Date.now();
    const frozen = new Set(this.store.getOverlayNotes().map(n => n.dimension));
    for (const [param, lastTime] of this.lastAdjustmentTime.entries()) {
      if (frozen.has(param)) continue; // ★ Overlay 豁免：稳定演化不回归
      if (now - lastTime < STALE_THRESHOLD_MS) continue;

      const persona = this.store.get();
      const paramParts = param.split('.');
      let currentValue = 0;
      /** 回归目标：人格参数是 0（中性），**记忆旋钮是各自的默认值** */
      let target = 0;

      if (paramParts[0] === 'tone' && paramParts[1]) {
        const tone = JSON.parse(persona.tone);
        currentValue = tone[paramParts[1]] || 0;
      } else if (paramParts[0] === 'speech_style' && paramParts[1]) {
        const style = JSON.parse(persona.speech_style);
        currentValue = style[paramParts[1]] || 0;
      } else if (paramParts[0] === 'emotional_range' && paramParts[1]) {
        const range = JSON.parse(persona.emotional_range);
        currentValue = range[paramParts[1]] || 0;
      } else if (paramParts[0] === 'memory' && paramParts[1]) {
        const config = this.store.getMemoryConfig();
        currentValue = (config as unknown as Record<string, number>)[paramParts[1]] || 0;
        // ★ 关键修复：目标是该旋钮的默认值，不是 0
        target = (DEFAULT_MEMORY_CONFIG as unknown as Record<string, number>)[paramParts[1]] ?? 0;
      }

      if (currentValue === target) continue;

      // 朝目标挪 REGRESSION_AMOUNT，不越过目标（分段判断，不是简单的正负）
      const gap = currentValue - target;
      const regressionDelta = gap > 0
        ? -Math.min(REGRESSION_AMOUNT, gap)
        : Math.min(REGRESSION_AMOUNT, -gap);

      this.applyToParam(param, regressionDelta);
      this.lastAdjustmentTime.set(param, now);

      this.store.addAdaptationHint({
        trigger: 'stale_regression',
        adjustment: { [param]: regressionDelta },
        evidence: target === 0
          ? 'No signal for >24h, regressed toward default'
          : `No signal for >24h, regressed toward default (${target})`,
        applied_at: new Date().toISOString(),
        // ★ add-memory-channel-field：**系统发起**的回归，不是任何用户渠道
        channel: 'system' as MemoryChannel,
      });
    }
  }

  private applyToParam(param: string, delta: number): void {
    const persona = this.store.get();
    const paramParts = param.split('.');

    if (paramParts[0] === 'tone' && paramParts[1]) {
      const tone = JSON.parse(persona.tone);
      tone[paramParts[1]] = this.clamp((tone[paramParts[1]] || 0) + delta);
      this.store.updateTone(JSON.stringify(tone));
    } else if (paramParts[0] === 'speech_style' && paramParts[1]) {
      const style = JSON.parse(persona.speech_style);
      style[paramParts[1]] = this.clamp((style[paramParts[1]] || 0) + delta);
      this.store.updateSpeechStyle(JSON.stringify(style));
    } else if (paramParts[0] === 'emotional_range' && paramParts[1]) {
      const range = JSON.parse(persona.emotional_range);
      range[paramParts[1]] = this.clamp((range[paramParts[1]] || 0) + delta);
      this.store.updateEmotionalRange(JSON.stringify(range));
    } else if (paramParts[0] === 'memory' && paramParts[1]) {
      // v2: 记忆人格旋钮
      const config = this.store.getMemoryConfig();
      const key = paramParts[1];
      if (key in config) {
        const cur = (config as unknown as Record<string, number>)[key] || 0;
        // ★ 2026-10-20（change: `fix-memory-knob-regression`）：**按各自值域钳制**。
        //   旧实现走通用的 `clamp(-1,1)`，于是 `decay_rate` 能被调到 **-0.4**
        //   —— 而它的语义是 0..1（"0=不忘"），负值没有定义，下游只在个别地方
        //   `Math.max(decay_rate, 0.05)` 兜了一下，别处照样吃负值。
        const [lo, hi] = MEMORY_KNOB_BOUNDS[key] ?? [-1, 1];
        (config as unknown as Record<string, number>)[key] = Math.max(lo, Math.min(hi, cur + delta));
        this.store.updateMemoryConfig(config);
      }
    }
  }

  private clamp(value: number): number {
    return Math.max(-1, Math.min(1, value));
  }
}
