// src/memory/engines/PersonaAdapter.ts
import type { MemoryEvent, PersonaAdjustment } from '../types.js';
import { PersonaStore } from '../stores/PersonaStore.js';
import type { ILLMService } from '../interfaces/ILLMService.js';
import { logger } from '../../utils/logger.js';

const MAX_DELTA = 0.1;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONSECUTIVE_SAME_DIRECTION = 3;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const REGRESSION_AMOUNT = 0.05;
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
      const parsed = JSON.parse(response);
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
    } catch {
      // LLM returned invalid JSON, skip
    }
    return null;
  }

  /** ★ 8-28 情绪惯性漂移（memory-character-perspective）：生活事件累积 mood_value 驱动自然漂移——
   *  连续开心（moodValue≥15）→ playfulness 微升；连续低落（≤-15）→ empathy 微升。
   *  走 apply 5 道护栏（Δ 钳制/冷却/同向次数/24h 回归）；24h 回归把参数拉回默认，不会无限累积。 */
  adjustFromMood(moodValue: number): boolean {
    if (moodValue >= 15) {
      return this.apply({ param: 'emotional_range.playfulness', delta: 0.05, reason: '情绪惯性：连续开心，自然更活泼' });
    }
    if (moodValue <= -15) {
      return this.apply({ param: 'emotional_range.empathy', delta: 0.05, reason: '情绪惯性：连续低落，变得更敏感共情' });
    }
    return false;
  }

  apply(adjustment: PersonaAdjustment, options?: { bypassLimits?: boolean }): boolean {
    // Prevent concurrent apply() calls from racing on Maps
    if (this.applyLock) return false;
    this.applyLock = true;
    try {
      return this._applyLocked(adjustment, options);
    } finally {
      this.applyLock = false;
    }
  }

  private _applyLocked(adjustment: PersonaAdjustment, options?: { bypassLimits?: boolean }): boolean {
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
   * Regress persona params that haven't been adjusted in 24+ hours back toward 0.
   * Each stale param moves 0.05 toward the default (0), without overshooting.
   * ★ 8-29 Overlay 豁免：已固化的参数（overlay_notes 有记录）不再回归——稳定演化保留。
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
      }

      if (currentValue === 0) continue;

      // Move 0.05 toward 0, but don't overshoot
      const regressionDelta = currentValue > 0
        ? -Math.min(REGRESSION_AMOUNT, Math.abs(currentValue))
        : Math.min(REGRESSION_AMOUNT, Math.abs(currentValue));

      this.applyToParam(param, regressionDelta);
      this.lastAdjustmentTime.set(param, now);

      this.store.addAdaptationHint({
        trigger: 'stale_regression',
        adjustment: { [param]: regressionDelta },
        evidence: 'No signal for >24h, regressed toward default',
        applied_at: new Date().toISOString(),
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
      const key = paramParts[1] as keyof typeof config;
      if (key in config) {
        (config as unknown as Record<string, number>)[key] = this.clamp(((config as unknown as Record<string, number>)[key] || 0) + delta);
        this.store.updateMemoryConfig(config);
      }
    }
  }

  private clamp(value: number): number {
    return Math.max(-1, Math.min(1, value));
  }
}
