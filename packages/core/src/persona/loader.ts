import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import type { MemoryManager } from '../memory/MemoryManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev (tsx): __dirname = .../packages/core/src/persona
// In prod (compiled): __dirname = .../packages/core/dist/persona
// Files are copied to dist/persona during build, so use __dirname directly
const PERSONA_DIR = __dirname;

// Persona file configuration
const PERSONA_FILES = [
  'soul.md',        // 人格核心 — 最重要，加载顺序第一
  'identity.md',    // 角色定位
  'system.md',      // 系统规则
  'talk_system.md', // 纯聊天规则
  '01_default.md',  // 默认风格
  'canon_quotes.md',// 原作台词参考（不直接注入system prompt，作为语气参考）
] as const;

const WORLDBOOK_FILES = [
  'Cyrene.md',
  'characters.md',
  'world.md',
  'story.md',
  '_glossary.md',
  // ★ 8-27 生活化条目（life-system-narrative-refactor）：content_type='life_event'，
  //   事件生成器按 life_event 层随机采样——让事件从角色生活中自然生长
  'daily_life.md',
] as const;

/** ★ 8-27 按文件指定 worldbook 条目的 content_type/scope/priority 元数据
 *  （daily_life.md → life_event，生活背景优先于普通设定条目采样） */
const FILE_META: Record<string, { content_type: 'text' | 'life_event' | 'image'; scope: 'chat' | 'code' | 'both'; priority: number }> = {
  'daily_life.md': { content_type: 'life_event', scope: 'both', priority: 8 },
};

/** Read a persona file, returns empty string if not found */
function readPersonaFile(filename: string): string {
  try {
    return readFileSync(resolve(PERSONA_DIR, filename), 'utf-8').trim();
  } catch {
    return '';
  }
}

function readWorldbookFile(filename: string): string {
  try {
    return readFileSync(resolve(PERSONA_DIR, 'worldbook', filename), 'utf-8').trim();
  } catch {
    return '';
  }
}

/** Build the complete system prompt from persona files */
export function buildPersonaSystemPrompt(): string {
  const parts: string[] = [];

  // Core files in order
  for (const file of PERSONA_FILES) {
    if (file === 'canon_quotes.md') continue; // canon_quotes is reference only
    const content = readPersonaFile(file);
    if (content) {
      parts.push(content);
    }
  }

  // Worldbook files
  for (const file of WORLDBOOK_FILES) {
    const content = readWorldbookFile(file);
    if (content) {
      parts.push(content);
    }
  }

  return parts.join('\n\n---\n\n');
}

/** Seed the PersonaStore with initial Cyrene persona data */
export async function seedPersona(memoryManager: MemoryManager): Promise<void> {
  const soul = readPersonaFile('soul.md');
  if (!soul) {
    logger.warn('[Persona] soul.md not found — skipping persona seed');
    return;
  }

  // 构建内置角色包 'alysia'（昔涟）并导入，兼容 v3 角色系统
  const systemPrompt = buildPersonaSystemPrompt();
  try {
    const result = memoryManager.importRole({
      role: 'alysia',
      name: '昔涟',
      version: 1,
      system_prompt: systemPrompt,
      persona: {
        tone: { formality: 0.2, warmth: 0.9, humor: 0.4, directness: 0.5 },
        speech_style: { sentence_length: 0.4, emoji_usage: 0.3, code_heavy: 0.0, poetic_imagery: 0.7 },
        emotional_range: { expressiveness: 0.7, empathy: 0.9, playfulness: 0.5 },
      },
      activate: false, // 已有激活角色时不抢占
    });
    logger.info(`[Persona] Seeded 昔涟 persona data (role: alysia, worldbook: ${result.worldbookCount})`);
  } catch (err) {
    logger.warn('[Persona] Failed to seed persona:', err);
  }
}

/** Seed the WorldbookStore with Cyrene background knowledge */
export async function seedWorldbook(memoryManager: MemoryManager): Promise<void> {
  // 解析 md 文件为世界书条目，并入内置角色包 alysia
  const entries: Array<{
    trigger_keys: string;
    content: string;
    priority: number;
    content_type: 'text' | 'life_event' | 'image';
    scope: 'chat' | 'code' | 'both';
  }> = [];

  for (const file of WORLDBOOK_FILES) {
    const raw = readWorldbookFile(file);
    if (!raw) continue;

    // Parse markdown headings as entry separators
    const sections = raw.split(/(?=^## )/m).filter(s => s.trim());
    const meta = FILE_META[file] ?? { content_type: 'text', scope: 'chat', priority: file === 'Cyrene.md' ? 10 : 5 };
    for (const section of sections) {
      const titleMatch = section.match(/^## (.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : file.replace('.md', '');

      // Extract trigger words from the title and first paragraph
      const triggerWords = extractTriggerWords(title, section);

      entries.push({
        trigger_keys: JSON.stringify(triggerWords),
        content: section.trim(),
        priority: meta.priority,
        content_type: meta.content_type,
        scope: meta.scope as 'chat' | 'code' | 'both',
      });
    }
  }

  if (entries.length === 0) return;

  try {
    const result = memoryManager.importRole({
      role: 'alysia',
      name: '昔涟',
      system_prompt: buildPersonaSystemPrompt(),
      worldbook: entries.map(e => ({
        trigger_keys: JSON.parse(e.trigger_keys) as string[],
        content: e.content,
        priority: e.priority,
        content_type: e.content_type,
        scope: e.scope,
      })),
      activate: false,
    });
    logger.info(`[Persona] Seeded ${result.worldbookCount} worldbook entries`);
  } catch (err) {
    logger.warn('[Persona] Failed to seed worldbook:', err);
  }
}

/** Extract trigger keywords from title + content */
function extractTriggerWords(title: string, content: string): string[] {
  const words = new Set<string>();

  // From title
  title.split(/[、，,\s·]+/).forEach(w => {
    const cleaned = w.replace(/[「」《》""''【】]/g, '').trim();
    if (cleaned.length >= 1 && cleaned.length <= 10) words.add(cleaned);
  });

  // Scan for key terms in first 500 chars
  const firstParagraph = content.slice(0, 500);
  const keyPatterns = [
    /昔涟/g, /迷迷/g, /德谬歌/g, /翁法罗斯/g, /白厄/g,
    /开拓者/g, /记忆/g, /泰坦/g, /黄金裔/g, /三月七/g,
    /浮黎/g, /无漏净子/g, /善见天/g, /哀丽秘榭/g,
  ];
  for (const pattern of keyPatterns) {
    if (pattern.test(firstParagraph)) {
      words.add(pattern.source.replace(/\\/g, ''));
    }
  }

  return [...words].slice(0, 15);
}
