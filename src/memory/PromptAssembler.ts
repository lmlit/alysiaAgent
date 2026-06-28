// src/memory/PromptAssembler.ts
// Minimal stub for Task 5.2; will be replaced by full implementation in Task 6.1.
import type { ProfileStore } from './stores/ProfileStore';
import type { PersonaStore } from './stores/PersonaStore';
import type { ConversationStore } from './stores/ConversationStore';
import type { KnowledgeStore } from './stores/KnowledgeStore';
import type { WorldbookStore } from './stores/WorldbookStore';
import type { CodeContextStore } from './stores/CodeContextStore';

export class PromptAssembler {
  constructor(
    private profileStore: ProfileStore,
    private personaStore: PersonaStore,
    private conversationStore: ConversationStore,
    private knowledgeStore: KnowledgeStore,
    private worldbookStore: WorldbookStore,
    private codeContextStore: CodeContextStore,
  ) {}

  async assemble(mode: 'chat' | 'code'): Promise<string> {
    const persona = this.personaStore.get();
    const profile = this.profileStore.get();

    if (mode === 'chat') {
      return this.assembleChat(persona.name, profile);
    }

    return this.assembleCode(profile);
  }

  private assembleChat(personaName: string, profile: { basics: string; preferences: string; facts: string }): string {
    const parts: string[] = [
      `你是${personaName}，一个温柔贴心的AI助手。你总是用中文回应用户，语气亲切自然，善于倾听并给予温暖的反馈。`,
      '请根据以下用户信息来调整你的回应方式：',
    ];

    const basics = JSON.parse(profile.basics || '{}') as Record<string, unknown>;
    if (Object.keys(basics).length > 0) {
      parts.push(`用户基本信息：${JSON.stringify(basics, null, 2)}`);
    }

    const facts = JSON.parse(profile.facts || '[]') as Array<{ fact: string }>;
    if (facts.length > 0) {
      const factList = facts.map(f => f.fact).join('；');
      parts.push(`关于用户已知事实：${factList}`);
    }

    const prefs = JSON.parse(profile.preferences || '{}') as Record<string, unknown>;
    if (Object.keys(prefs).length > 0) {
      parts.push(`用户偏好：${JSON.stringify(prefs, null, 2)}`);
    }

    return parts.join('\n\n');
  }

  private assembleCode(profile: { basics: string; preferences: string }): string {
    const parts: string[] = [
      '你是一个AI代码助手。以下是与当前编程任务相关的上下文信息：',
    ];

    const basics = JSON.parse(profile.basics || '{}') as Record<string, unknown>;
    if (basics.occupation) {
      parts.push(`用户职业：${basics.occupation}`);
    }

    const prefs = JSON.parse(profile.preferences || '{}') as Record<string, unknown>;
    if (prefs.code_languages && Array.isArray(prefs.code_languages)) {
      parts.push(`用户常用编程语言：${(prefs.code_languages as string[]).join(', ')}`);
    }

    const codeCtx = this.codeContextStore.getActive();
    if (codeCtx) {
      parts.push(`当前项目：${codeCtx.project_name}`);
      parts.push(`项目路径：${codeCtx.project_path}`);
      const techStack = JSON.parse(codeCtx.tech_stack || '{}') as Record<string, unknown>;
      if (Object.keys(techStack).length > 0) {
        parts.push(`技术栈：${JSON.stringify(techStack, null, 2)}`);
      }
    }

    return parts.join('\n\n');
  }
}
