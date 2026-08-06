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

  async assemble(mode: 'chat' | 'code', extraRetrieved: SearchResult[] = [], worldbookTriggers: WorldbookEntry[] = [], lifeInjection: string = ''): Promise<string> {
    if (mode === 'chat') {
      return this.assembleChat(extraRetrieved, worldbookTriggers, lifeInjection);
    } else {
      return this.assembleCode(extraRetrieved, worldbookTriggers, lifeInjection);
    }
  }

  private async assembleChat(retrieved: SearchResult[], triggers: WorldbookEntry[], lifeInjection: string = ''): Promise<string> {
    const persona = this.personaStore.get();
    const profile = this.profileStore.get();
    const recentConvs = this.conversationStore.getRecent(3);
    const budget = new TokenBudget(3200);

    const blocks: string[] = [];

    // Persona block (always included — most essential)
    const tone = safeParseJSON<Record<string, number>>(persona.tone, {});
    const speechStyle = safeParseJSON<Record<string, number>>(persona.speech_style, {});
    const emotionalRange = safeParseJSON<Record<string, number>>(persona.emotional_range, {});
    const personaBlock = `[角色设定]
你是${persona.name}。
语气: 形式度=${tone.formality}, 温暖度=${tone.warmth}, 幽默感=${tone.humor}, 直接程度=${tone.directness}
说话风格: 句子长度=${speechStyle.sentence_length}, 表情使用=${speechStyle.emoji_usage}, 代码倾向=${speechStyle.code_heavy}
情感表达: 表现力=${emotionalRange.expressiveness}, 共情=${emotionalRange.empathy}, playful=${emotionalRange.playfulness}`;
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
    const activeFacts = this.profileStore.getActiveFacts();
    if (activeFacts.length > 0) {
      // 按置信度降序，同 key 去重
      const seen = new Set<string>();
      const factsText = activeFacts
        .sort((a, b) => b.confidence - a.confidence)
        .map(f => {
          const key = f.fact.replace(/[的得了吗呢是个了]/g, '').slice(0, 15);
          if (seen.has(key)) return null;
          seen.add(key);
          const marker = f.source === 'inferred' ? '(待确认)' : '';
          const sourceNote = f.source === 'user' ? ' [你说过]' : '';
          return `- ${f.fact}${marker}${sourceNote}`;
        })
        .filter(Boolean)
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
      const lifeBlock = lifeInjection;
      if (budget.canFit(lifeBlock)) {
        budget.reserve(lifeBlock);
        blocks.push(lifeBlock);
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
      const lifeBlock = lifeInjection;
      if (budget.canFit(lifeBlock)) {
        budget.reserve(lifeBlock);
        blocks.push(lifeBlock);
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
      const tone = safeParseJSON<Record<string, number>>(persona.tone, {});
      const speechStyle = safeParseJSON<Record<string, number>>(persona.speech_style, {});
      const emotionalRange = safeParseJSON<Record<string, number>>(persona.emotional_range, {});
      return `[角色设定]
你是${persona.name}。
语气: 形式度=${tone.formality}, 温暖度=${tone.warmth}, 幽默感=${tone.humor}, 直接程度=${tone.directness}
说话风格: 句子长度=${speechStyle.sentence_length}, 表情使用=${speechStyle.emoji_usage}, 代码倾向=${speechStyle.code_heavy}
情感表达: 表现力=${emotionalRange.expressiveness}, 共情=${emotionalRange.empathy}, playful=${emotionalRange.playfulness}

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
