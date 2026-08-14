/**
 * Worldbook Skills — 背景知识按需加载
 *
 * 每个条目有唯一 ID + 一行摘要（供 LLM 扫描选择）。
 * LLM 传入多个 ID，工具返回对应条目内容。
 * 每条内容精炼到 250 字以内，不爆 context。
 */
import type Database from 'better-sqlite3';
import type { ToolDefinition } from './registry.js';

function buildSkillIndex(db: Database.Database): Map<string, { title: string; summary: string; content: string }> {
  const index = new Map<string, { title: string; summary: string; content: string }>();
  try {
    const rows = db.prepare('SELECT trigger_keys, content FROM worldbook_entries ORDER BY priority DESC').all() as Array<{ trigger_keys: string; content: string }>;
    for (const row of rows) {
      const keys = JSON.parse(row.trigger_keys) as string[];
      if (keys.length === 0) continue;
      const id = keys[0].replace(/[^a-zA-Z0-9一-鿿]/g, '_').slice(0, 20).toLowerCase();
      const title = keys[0];
      const summary = extractFirstLine(row.content);
      const content = condense(row.content);
      index.set(id, { title, summary, content });
    }
  } catch { /* table may not exist */ }
  return index;
}

function extractFirstLine(content: string): string {
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#') || t.startsWith('-') || t.startsWith('>') || t.length < 10) continue;
    return t.slice(0, 60) + (t.length > 60 ? '…' : '');
  }
  return content.slice(0, 60);
}

function condense(content: string): string {
  let text = content
    .replace(/^#+ .+$/gm, '')
    .replace(/^[-*]\s/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (text.length <= 250) return text;
  return text.slice(0, 247) + '...';
}

export function createWorldbookTool(db: Database.Database): ToolDefinition {
  // ★ 8-14 内容自进化：索引改为 handler 内实时构建（原启动冻结 → 自写条目查不到 = 自相矛盾）。
  //  条目量小（几十条），每次调用重建成本可忽略。
  return {
    name: 'lookup_worldbook',
    description: '查询昔涟的背景知识（崩坏星穹铁道角色设定）。当用户问及昔涟的身世、来历、过去，或提到翁法罗斯、白厄、迷迷、德谬歌、浮黎、泰坦、黄金裔、哀丽秘榭、铁幕、绝灭大君等关键词时调用。传入关键词即可搜索。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词，如"白厄"、"翁法罗斯"、"迷迷"' },
      },
      required: ['keyword'],
    },
    handler: async (args) => {
      const keyword = (args.keyword || '') as string;
      if (!keyword) return '请提供搜索关键词。';

      const skillIndex = buildSkillIndex(db); // ★ 实时构建：自写条目即刻可查
      // 搜索匹配的条目
      const results: string[] = [];
      for (const [id, val] of skillIndex) {
        if (id.includes(keyword) || val.title.includes(keyword) || val.summary.includes(keyword)) {
          results.push(`## ${val.title}\n${val.content}`);
          if (results.length >= 3) break;
        }
      }

      if (results.length === 0) {
        return `未找到关于"${keyword}"的背景知识。试试: ${[...skillIndex.keys()].slice(0, 8).join(', ')}`;
      }
      return results.join('\n\n---\n\n');
    },
  };
}
