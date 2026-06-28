// src/memory/PromptAssembler.ts
import type { ProfileStore } from './stores/ProfileStore';
import type { PersonaStore } from './stores/PersonaStore';
import type { ConversationStore } from './stores/ConversationStore';
import type { KnowledgeStore } from './stores/KnowledgeStore';
import type { WorldbookStore } from './stores/WorldbookStore';
import type { CodeContextStore } from './stores/CodeContextStore';
import type { SearchResult, WorldbookEntry } from './types';
import { TokenBudget } from './TokenBudget';

export class PromptAssembler {
  constructor(
    private profileStore: ProfileStore,
    private personaStore: PersonaStore,
    private conversationStore: ConversationStore,
    private knowledgeStore: KnowledgeStore,
    private worldbookStore: WorldbookStore,
    private codeContextStore: CodeContextStore,
  ) {}

  async assemble(mode: 'chat' | 'code', extraRetrieved: SearchResult[] = [], worldbookTriggers: WorldbookEntry[] = []): Promise<string> {
    if (mode === 'chat') {
      return this.assembleChat(extraRetrieved, worldbookTriggers);
    } else {
      return this.assembleCode(extraRetrieved, worldbookTriggers);
    }
  }

  private async assembleChat(retrieved: SearchResult[], triggers: WorldbookEntry[]): Promise<string> {
    const persona = this.personaStore.get();
    const profile = this.profileStore.get();
    const recentConvs = this.conversationStore.getRecent(3);
    const budget = new TokenBudget(3200);

    const blocks: string[] = [];

    // Persona block (always included — most essential)
    const tone = JSON.parse(persona.tone);
    const speechStyle = JSON.parse(persona.speech_style);
    const emotionalRange = JSON.parse(persona.emotional_range);
    const personaBlock = `[角色设定]
你是${persona.name}。
语气: 形式度=${tone.formality}, 温暖度=${tone.warmth}, 幽默感=${tone.humor}, 直接程度=${tone.directness}
说话风格: 句子长度=${speechStyle.sentence_length}, 表情使用=${speechStyle.emoji_usage}, 代码倾向=${speechStyle.code_heavy}
情感表达: 表现力=${emotionalRange.expressiveness}, 共情=${emotionalRange.empathy}, playful=${emotionalRange.playfulness}`;
    budget.reserve(personaBlock);
    blocks.push(personaBlock);

    // User profile block
    const basics = JSON.parse(profile.basics);
    const prefs = JSON.parse(profile.preferences);
    if (Object.keys(basics).length > 0) {
      const basicsBlock = `[关于你]\n${JSON.stringify(basics, null, 2)}`;
      if (budget.canFit(basicsBlock)) {
        budget.reserve(basicsBlock);
        blocks.push(basicsBlock);
      }
    }
    if (Object.keys(prefs).length > 0) {
      const prefsBlock = `[你的偏好]\n${JSON.stringify(prefs, null, 2)}`;
      if (budget.canFit(prefsBlock)) {
        budget.reserve(prefsBlock);
        blocks.push(prefsBlock);
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

    // Retrieved memories
    if (retrieved.length > 0) {
      const memBlock = `[相关记忆]\n${retrieved.map(r => `- ${r.text}`).join('\n')}`;
      if (budget.canFit(memBlock)) {
        budget.reserve(memBlock);
        blocks.push(memBlock);
      }
    }

    // Worldbook triggers
    if (triggers.length > 0) {
      const wbBlock = `[情境提示]\n${triggers.map(w => w.content).join('\n')}`;
      if (budget.canFit(wbBlock)) {
        budget.reserve(wbBlock);
        blocks.push(wbBlock);
      }
    }

    return blocks.join('\n\n');
  }

  private async assembleCode(retrieved: SearchResult[], triggers: WorldbookEntry[]): Promise<string> {
    const persona = this.personaStore.get();
    const profile = this.profileStore.get();
    const codeCtx = this.codeContextStore.getActive();
    const budget = new TokenBudget(2450);

    const blocks: string[] = [];

    // Compressed persona — only key tone dimensions for code mode (always included)
    const tone = JSON.parse(persona.tone);
    const personaBlock = `[角色设定]
${persona.name} 编程助手模式。语气: ${tone.formality < 0 ? '随意' : '正式'}，直接程度: ${tone.directness > 0 ? '直接' : '委婉'}`;
    budget.reserve(personaBlock);
    blocks.push(personaBlock);

    // Filtered profile — technical fields only (occupation, experience, code_languages, code_style, comment_style)
    // Code preferences are included here; no separate [编码偏好] block to avoid duplication.
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

    // Project context
    if (codeCtx) {
      const tech = JSON.parse(codeCtx.tech_stack);
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

    // Worldbook triggers (code scope only)
    const codeTriggers = triggers.filter(w => w.scope === 'code' || w.scope === 'both');
    if (codeTriggers.length > 0) {
      const wbBlock = `[情境提示]\n${codeTriggers.map(w => w.content).join('\n')}`;
      if (budget.canFit(wbBlock)) {
        budget.reserve(wbBlock);
        blocks.push(wbBlock);
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
}
