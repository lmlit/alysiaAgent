// src/memory/engines/PersonaAdapter.ts
import type { MemoryEvent, PersonaAdjustment } from '../types';
import { PersonaStore } from '../stores/PersonaStore';
import type { ILLMService } from '../interfaces/ILLMService';

const MAX_DELTA = 0.1;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONSECUTIVE_SAME_DIRECTION = 3;

export class PersonaAdapter {
  private lastAdjustmentTime = new Map<string, number>();
  private consecutiveDirection = new Map<string, { direction: number; count: number }>();

  constructor(private store: PersonaStore, private llm: ILLMService) {}

  async processSignal(event: MemoryEvent): Promise<PersonaAdjustment | null> {
    // Check if content contains explicit preference signals
    const content = (event.payload.content as string) || '';
    const hasPreferenceSignal = /太+|能不能别|我喜欢|我讨厌|不要|别|更|再/.test(content);
    if (!hasPreferenceSignal) return null;

    // Ask LLM to determine adjustment
    const persona = this.store.get();
    const prompt = `当前人格参数: ${JSON.stringify({
      tone: JSON.parse(persona.tone),
      speech: JSON.parse(persona.speech_style),
      emotional: JSON.parse(persona.emotional_range),
    })}\n用户消息: "${content}"\n判断是否需要调整，返回JSON: {"adjustments": [{"param": "...", "delta": 0.0, "reason": "..."}]} 或 {"adjustments": []}`;

    const response = await this.llm.complete(
      '你是人格参数调节器。根据用户反馈判断人格参数是否需要微调。delta范围[-0.1, 0.1]。',
      prompt
    );

    try {
      const parsed = JSON.parse(response);
      if (parsed.adjustments && parsed.adjustments.length > 0) {
        const adj = parsed.adjustments[0];
        return { param: adj.param, delta: adj.delta, reason: adj.reason };
      }
    } catch {
      // LLM returned invalid JSON, skip
    }
    return null;
  }

  apply(adjustment: PersonaAdjustment): boolean {
    // Clamp delta
    const clampedDelta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, adjustment.delta));

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

    // Apply to correct dimension
    this.applyToParam(adjustment.param, clampedDelta);

    // Record
    this.lastAdjustmentTime.set(adjustment.param, now);
    this.store.addAdaptationHint({
      trigger: 'auto_adapt',
      adjustment: { [adjustment.param]: clampedDelta },
      evidence: adjustment.reason,
      applied_at: new Date().toISOString(),
    });

    return true;
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
    }
  }

  private clamp(value: number): number {
    return Math.max(-1, Math.min(1, value));
  }
}
