// src/memory/PromptAssembler.ts
import type { ProfileStore } from './stores/ProfileStore.js';
import type { PersonaStore } from './stores/PersonaStore.js';
import type { ConversationStore } from './stores/ConversationStore.js';
import type { KnowledgeStore } from './stores/KnowledgeStore.js';
import type { WorldbookStore } from './stores/WorldbookStore.js';
import type { CodeContextStore } from './stores/CodeContextStore.js';
import type { SearchResult, WorldbookEntry } from './types.js';
import { TokenBudget } from './TokenBudget.js';
import { logger } from '../utils/logger.js';

export class PromptAssembler {
  constructor(
    private profileStore: ProfileStore,
    private personaStore: PersonaStore,
    private conversationStore: ConversationStore,
    private knowledgeStore: KnowledgeStore,
    private worldbookStore: WorldbookStore,
    private codeContextStore: CodeContextStore,
  ) {}

  async assemble(mode: 'chat' | 'code', extraRetrieved: SearchResult[] = [], worldbookTriggers: WorldbookEntry[] = [], lifeInjection: string = '', sessionId?: string): Promise<string> {
    if (mode === 'chat') {
      return this.assembleChat(extraRetrieved, worldbookTriggers, lifeInjection, sessionId);
    } else {
      return this.assembleCode(extraRetrieved, worldbookTriggers, lifeInjection);
    }
  }

  private async assembleChat(retrieved: SearchResult[], triggers: WorldbookEntry[], lifeInjection: string = '', sessionId?: string): Promise<string> {
    const persona = this.personaStore.get();
    const profile = this.profileStore.get();
    // ★ 8-09 会话隔离：只取当前会话类型（private/同群）的摘要，防群聊摘要混入私聊
    const recentConvs = this.conversationStore.getRecent(3, sessionId);
    const budget = new TokenBudget(3200);

    const blocks: string[] = [];

    // Persona block (always included — most essential)
    // ★ 8-09 防御：tone 空对象/缺失字段 → 默认参数（云端历史遗留 tone='{}' 导致 undefined）
    const tone = safeParseJSON<Record<string, number>>(persona.tone, {});
    const speechStyle = safeParseJSON<Record<string, number>>(persona.speech_style, {});
    const emotionalRange = safeParseJSON<Record<string, number>>(persona.emotional_range, {});
    const t = (v: number | undefined, def: number) => (typeof v === 'number' && isFinite(v) ? v : def);
    const toneText = `语气: 形式度=${t(tone.formality, 0)}, 温暖度=${t(tone.warmth, 0.2)}, 幽默感=${t(tone.humor, 0.1)}, 直接程度=${t(tone.directness, 0)}`;
    const styleText = `说话风格: 句子长度=${t(speechStyle.sentence_length, 0)}, 表情使用=${t(speechStyle.emoji_usage, 0)}, 代码倾向=${t(speechStyle.code_heavy, 0)}`;
    const rangeText = `情感表达: 表现力=${t(emotionalRange.expressiveness, 0.1)}, 共情=${t(emotionalRange.empathy, 0.3)}, playful=${t(emotionalRange.playfulness, 0.1)}`;
    const personaBlock = `[角色设定]
你是${persona.name}。
${toneText}
${styleText}
${rangeText}`;
    budget.reserve(personaBlock);
    blocks.push(personaBlock);

    // User profile — handles both JSON (manual input) and plain text (LLM summary from Cron)
    if (profile.basics && profile.basics !== '{}') {
      const basicsText = this.parseOrPlain(profile.basics);
      if (basicsText) {
        const basicsBlock = `[关于你]\n${basicsText}`;
        if (budget.canFit(basicsBlock)) {
          budget.reserve(basicsBlock);
          blocks.push(basicsBlock);
        }
      }
    }
    if (profile.preferences && profile.preferences !== '{}') {
      const prefsText = this.parseOrPlain(profile.preferences);
      if (prefsText) {
        const prefsBlock = `[你的偏好]\n${prefsText}`;
        if (budget.canFit(prefsBlock)) {
          budget.reserve(prefsBlock);
          blocks.push(prefsBlock);
        }
      }
    }

    // Active profile facts (v2: 只显示活跃事实，标注来源)
    // ★ 8-09 去重增强：归一化（去停用字/主语/标点）+ 子串包含合并——历史重复数据
    //   （"用户在长沙" ×4）在组装层兜底消除，不显示即不烧 token
    const activeFacts = this.profileStore.getActiveFacts();
    if (activeFacts.length > 0) {
      const norm = (s: string) => s.replace(/[的得了吗呢是个了在于是和也呀啊哦吧]/g, '').replace(/^(用户|你)/, '').replace(/[\s，,。！？；;：:、()（）"“”']/g, '').toLowerCase();
      const normContains = (a: string, b: string) => {
        const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
        return longer.length >= 5 && shorter.length >= 2 && longer.includes(shorter);
      };
      const kept: typeof activeFacts = [];
      for (const f of activeFacts.sort((a, b) => b.confidence - a.confidence)) {
        const key = norm(f.fact);
        const dup = kept.find(k => norm(k.fact) === key || normContains(norm(k.fact), key));
        if (dup) continue; // 已有同义事实（保留置信度更高的第一条）
        kept.push(f);
      }
      const factsText = kept
        .map(f => {
          const marker = f.source === 'inferred' ? '(待确认)' : '';
          const sourceNote = f.source === 'user' ? ' [你说过]' : '';
          return `- ${f.fact}${marker}${sourceNote}`;
        })
        .join('\n');
      if (factsText) {
        const factsBlock = `[关于你的事实]\n${factsText}`;
        if (budget.canFit(factsBlock)) {
          budget.reserve(factsBlock);
          blocks.push(factsBlock);
        }
      }
    }

    // Recent conversations
    if (recentConvs.length > 0) {
      const recentBlock = `[最近对话]\n${recentConvs.map(c => `- ${c.summary}`).join('\n')}`;
      if (budget.canFit(recentBlock)) {
        budget.reserve(recentBlock);
        blocks.push(recentBlock);
      }
    }

    // AI 近期生活（主动生活系统）— 由调用方通过 getLifeEventInjection() 预组装（今天事件 + 近 7 天摘要）
    if (lifeInjection) {
      if (budget.canFit(lifeInjection)) {
        budget.reserve(lifeInjection);
        blocks.push(lifeInjection);
      } else {
        logger.debug('[Life] life block skipped (budget)');
      }
    }

    // Retrieved memories
    if (retrieved.length > 0) {
      const memBlock = `[相关记忆]\n${retrieved.map(r => `- ${r.text}`).join('\n')}`;
      if (budget.canFit(memBlock)) {
        budget.reserve(memBlock);
        blocks.push(memBlock);
      }
    }

    // Worldbook 已改为 Agent 工具 lookup_worldbook，不再注入 Prompt
    // Agent 在需要背景知识时会主动调用工具查询

    return blocks.join('\n\n');
  }

  private async assembleCode(retrieved: SearchResult[], triggers: WorldbookEntry[], lifeInjection: string = ''): Promise<string> {
    const persona = this.personaStore.get();
    const profile = this.profileStore.get();
    const codeCtx = this.codeContextStore.getActive();
    const budget = new TokenBudget(2450);

    const blocks: string[] = [];

    // Compressed persona — only key tone dimensions for code mode (always included)
    const tone = safeParseJSON<Record<string, number>>(persona.tone, {});
    const personaBlock = `[角色设定]
${persona.name} 编程助手模式。语气: ${tone.formality < 0 ? '随意' : '正式'}，直接程度: ${tone.directness > 0 ? '直接' : '委婉'}`;
    budget.reserve(personaBlock);
    blocks.push(personaBlock);

    // Filtered profile — technical fields only.
    // Handles both JSON (structured) and plain text (LLM summary from Cron deep rewrite).
    try {
      const basics = JSON.parse(profile.basics);
      const prefs = JSON.parse(profile.preferences);
      const techProfile: string[] = [];
      if (basics.occupation) techProfile.push(`角色: ${basics.occupation}`);
      if (basics.experience) techProfile.push(`经验: ${basics.experience}`);
      if (prefs.code_languages) techProfile.push(`技术栈: ${JSON.stringify(prefs.code_languages)}`);
      if (prefs.code_style) techProfile.push(`代码风格: ${prefs.code_style}`);
      if (prefs.comment_style) techProfile.push(`注释: ${prefs.comment_style}`);
      if (techProfile.length > 0) {
        const techBlock = `[编程用户画像]\n${techProfile.join('\n')}`;
        if (budget.canFit(techBlock)) {
          budget.reserve(techBlock);
          blocks.push(techBlock);
        }
      }
    } catch {
      // basics is not JSON (LLM summary) — include a short snippet as context
      if (profile.basics && profile.basics !== '{}') {
        const snippet = profile.basics.slice(0, 200);
        const techBlock = `[编程用户画像]\n${snippet}`;
        if (budget.canFit(techBlock)) {
          budget.reserve(techBlock);
          blocks.push(techBlock);
        }
      }
    }

    // Project context
    if (codeCtx) {
      const tech = safeParseJSON<Record<string, unknown>>(codeCtx.tech_stack, {});
      const ctxBlock = `[当前项目]
- 项目: ${codeCtx.project_name}
- 技术栈: ${JSON.stringify(tech)}
- 架构: ${codeCtx.architecture_notes}
- 最近: ${codeCtx.recent_changes}`;
      if (budget.canFit(ctxBlock)) {
        budget.reserve(ctxBlock);
        blocks.push(ctxBlock);
      }
    }

    // Worldbook triggers (code scope only) — 排除表情包条目（image 类型走 send_sticker 工具）
    const codeTriggers = triggers.filter(w => (w.scope === 'code' || w.scope === 'both') && w.content_type !== 'image');
    if (codeTriggers.length > 0) {
      const wbBlock = `[情境提示]\n${codeTriggers.map(w => w.content).join('\n')}`;
      if (budget.canFit(wbBlock)) {
        budget.reserve(wbBlock);
        blocks.push(wbBlock);
      }
    }

    // AI 近期生活（主动生活系统）— AI 把生活带进编程模式（今天事件 + 近 7 天摘要）
    if (lifeInjection) {
      if (budget.canFit(lifeInjection)) {
        budget.reserve(lifeInjection);
        blocks.push(lifeInjection);
      } else {
        logger.debug('[Life] life block skipped (budget)');
      }
    }

    // Retrieved knowledge
    if (retrieved.length > 0) {
      const knowBlock = `[相关知识]\n${retrieved.map(r => `- ${r.text}`).join('\n')}`;
      if (budget.canFit(knowBlock)) {
        budget.reserve(knowBlock);
        blocks.push(knowBlock);
      }
    }

    return blocks.join('\n\n');
  }

  /** 隐私模式：仅注入角色设定，不含用户画像/Worldbook/记忆 */
  async assembleMinimal(mode: 'chat' | 'code'): Promise<string> {
    const persona = this.personaStore.get();
    if (mode === 'chat') {
      // ★ 8-09：与 assembleChat 同款空值兜底（tone='{}' 历史数据不再输出 undefined）
      const tone = safeParseJSON<Record<string, number>>(persona.tone, {});
      const speechStyle = safeParseJSON<Record<string, number>>(persona.speech_style, {});
      const emotionalRange = safeParseJSON<Record<string, number>>(persona.emotional_range, {});
      const t = (v: number | undefined, def: number) => (typeof v === 'number' && isFinite(v) ? v : def);
      return `[角色设定]
你是${persona.name}。
语气: 形式度=${t(tone.formality, 0)}, 温暖度=${t(tone.warmth, 0.2)}, 幽默感=${t(tone.humor, 0.1)}, 直接程度=${t(tone.directness, 0)}
说话风格: 句子长度=${t(speechStyle.sentence_length, 0)}, 表情使用=${t(speechStyle.emoji_usage, 0)}, 代码倾向=${t(speechStyle.code_heavy, 0)}
情感表达: 表现力=${t(emotionalRange.expressiveness, 0.1)}, 共情=${t(emotionalRange.empathy, 0.3)}, playful=${t(emotionalRange.playfulness, 0.1)}

(隐私模式 — 未加载用户画像和记忆)`;
    } else {
      const tone = safeParseJSON<Record<string, number>>(persona.tone, {});
      return `${persona.name} 编程助手模式(隐私)。`;
    }
  }

  /** Parse JSON if possible, else return the text as-is (LLM summary from Cron) */
  private parseOrPlain(raw: string): string {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0) {
        return JSON.stringify(parsed, null, 2);
      }
      return '';
    } catch {
      // Not JSON — use as plain text (LLM-generated natural language summary)
      return raw;
    }
  }
}

/** Safely parse JSON with a fallback value, logging on failure */
function safeParseJSON<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    logger.warn(`[PromptAssembler] Failed to parse JSON: ${raw.slice(0, 100)}`);
    return fallback;
  }
}
