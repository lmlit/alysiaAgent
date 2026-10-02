/**
 * `MemoryManager.getCompactPersonaPrompt()` 回归测试。
 *
 * ★ 它是一句内联表达式的**提取**（2026-10-01，change: connect-dsh-alysia-bridge）：
 *
 *   // 提取前（llm-agent.ts）
 *   getActiveSystemPrompt().split('\n---\n').slice(0, 4).join('\n---\n')
 *
 * 提出来的理由是**只能有一处定义** —— dsh 侧动态人设（`GET /api/persona/prompt`）
 * 必须和聊天管线取到同一份文本，否则她在 dsh 里和 QQ 里会是两个人。
 *
 * 所以这个测试锁的是「提取没有改变行为」，等价于把旧表达式原样再算一遍比对。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../../src/memory/MemoryManager.js';
import { initializeDatabase } from '../../../src/memory/database.js';

/** 抽取前的管线实现（原样保留在这里当参照物） */
function legacyCompact(full: string): string {
  return full.split('\n---\n').slice(0, 4).join('\n---\n');
}

const SECTIONS = [
  '你是昔涟，黄金裔的少女。',
  '说话温柔，带一点点俏皮。',
  '你记得与轻月共同经历过的事。',
  '不要主动打破沉浸感。',
  '【世界书】以下是六十六条设定……（很长）',
  '【世界书】另一段设定……（更长）',
];

describe('getCompactPersonaPrompt', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    // 写进激活行：PersonaStore.get() 读 WHERE is_active = 1
    db.prepare('UPDATE persona SET system_prompt = ? WHERE is_active = 1').run(SECTIONS.join('\n---\n'));
    mm = new MemoryManager(db, null, { embed: async () => [], dimension: () => 1 } as never, { complete: async () => '' } as never);
  });

  afterEach(() => db.close());

  it('★ 与管线旧表达式逐字一致（提取未改变行为）', () => {
    const full = mm.getActiveSystemPrompt();
    expect(full).toBe(SECTIONS.join('\n---\n'));
    expect(mm.getCompactPersonaPrompt()).toBe(legacyCompact(full));
  });

  it('只保留前 4 节（worldbook 动辄 15k 字符，全量注入会吃光 context）', () => {
    const out = mm.getCompactPersonaPrompt();
    expect(out.split('\n---\n')).toHaveLength(4);
    expect(out).toContain(SECTIONS[3]);
    expect(out).not.toContain('【世界书】');
  });

  it('节数可覆盖（dsh 侧若想要更短/更长的人设）', () => {
    expect(mm.getCompactPersonaPrompt(1)).toBe(SECTIONS[0]);
    expect(mm.getCompactPersonaPrompt(6).split('\n---\n')).toHaveLength(6);
  });

  it('人设只有一节时不炸（split 后仍是单元素）', () => {
    db.prepare('UPDATE persona SET system_prompt = ? WHERE is_active = 1').run('只有一段。');
    expect(mm.getCompactPersonaPrompt()).toBe('只有一段。');
  });

  it('人设为空时返回空串（不抛）——dsh 侧拿到空的人设只是没个性，不该崩', () => {
    db.prepare('UPDATE persona SET system_prompt = ? WHERE is_active = 1').run('');
    expect(mm.getCompactPersonaPrompt()).toBe('');
  });
});
