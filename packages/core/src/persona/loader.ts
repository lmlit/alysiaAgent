import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
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
] as const;

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
  const identity = readPersonaFile('identity.md');
  const defaultStyle = readPersonaFile('01_default.md');

  if (!soul) {
    console.warn('[Persona] soul.md not found — skipping persona seed');
    return;
  }

  // The PersonaStore uses default row (id=1). We set the persona through the
  // existing PersonaAdapter which writes to persona table.
  // For now, store the full soul + identity text as the persona's base content
  // via the PersonaStore's update mechanism.
  // The PersonaStore stores: name, tone (JSON), speech_style (JSON),
  // emotional_range (JSON), adaptation_hints (JSON)

  const db = (memoryManager as any).db;
  if (!db) return;

  const personaData = {
    name: '昔涟',
    tone: JSON.stringify({
      formality: 0.2,        // 句尾"呀""呢""啦"，非正式
      warmth: 0.9,           // 温柔但不软弱
      humor: 0.4,            // 轻盈俏皮但不喧闹
      directness: 0.5,       // 含蓄但有主见
    }),
    speech_style: JSON.stringify({
      sentence_length: 0.4,  // 短句，有留白
      emoji_usage: 0.3,      // ♪ 点缀用
      code_heavy: 0.0,       // 不涉及代码
      poetic_imagery: 0.7,   // 花、种子、涟漪、星星、光、风
    }),
    emotional_range: JSON.stringify({
      expressiveness: 0.7,   // 情感真实，不掩藏
      empathy: 0.9,          // 高度共情
      playfulness: 0.5,      // 适度俏皮
    }),
    adaptation_hints: JSON.stringify([]),
    updated_at: new Date().toISOString(),
    // Store the raw soul text for prompt assembly
    _soul_raw: soul,
    _identity_raw: identity || '',
    _default_style_raw: defaultStyle || '',
  };

  try {
    // Upsert persona (id=1 is the default)
    const existing = db.prepare('SELECT id FROM persona WHERE id = 1').get();
    if (existing) {
      db.prepare(`
        UPDATE persona SET
          name = ?, tone = ?, speech_style = ?, emotional_range = ?,
          adaptation_hints = ?, updated_at = ?
        WHERE id = 1
      `).run(
        personaData.name, personaData.tone, personaData.speech_style,
        personaData.emotional_range, personaData.adaptation_hints,
        personaData.updated_at,
      );
    } else {
      db.prepare(`
        INSERT INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?)
      `).run(
        personaData.name, personaData.tone, personaData.speech_style,
        personaData.emotional_range, personaData.adaptation_hints,
        personaData.updated_at,
      );
    }
    console.log('[Persona] Seeded 昔涟 persona data');
  } catch (err) {
    console.warn('[Persona] Failed to seed persona:', err);
  }
}

/** Seed the WorldbookStore with Cyrene background knowledge */
export async function seedWorldbook(memoryManager: MemoryManager): Promise<void> {
  const db = (memoryManager as any).db;
  if (!db) return;

  // Parse worldbook files into entries
  // Each worldbook file contains multiple entries separated by headings (## Title)
  const entries: Array<{
    trigger_keys: string;
    content: string;
    priority: number;
  }> = [];

  for (const file of WORLDBOOK_FILES) {
    const raw = readWorldbookFile(file);
    if (!raw) continue;

    // Parse markdown headings as entry separators
    const sections = raw.split(/(?=^## )/m).filter(s => s.trim());
    for (const section of sections) {
      const titleMatch = section.match(/^## (.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : file.replace('.md', '');

      // Extract trigger words from the title and first paragraph
      const triggerWords = extractTriggerWords(title, section);

      entries.push({
        trigger_keys: JSON.stringify(triggerWords),
        content: section.trim(),
        priority: file === 'Cyrene.md' ? 10 : 5,
      });
    }
  }

  // Insert into worldbook table
  const insert = db.prepare(`
    INSERT OR IGNORE INTO worldbook (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at)
    VALUES (?, ?, 'any', ?, 'chat', ?, 300, NULL, 0, ?, ?)
  `);

  const now = new Date().toISOString();
  let count = 0;
  for (const entry of entries) {
    const id = hashId(entry.content);
    try {
      insert.run(id, entry.trigger_keys, entry.content, entry.priority, now, now);
      count++;
    } catch { /* duplicate, skip */ }
  }

  console.log(`[Persona] Seeded ${count} worldbook entries`);
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

function hashId(content: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(content.length, 500); i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    hash |= 0;
  }
  return `wb_${Math.abs(hash).toString(36)}`;
}
