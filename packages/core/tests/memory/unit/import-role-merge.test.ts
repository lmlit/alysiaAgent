/**
 * `importRole` 的字段合并语义回归（change: fix-role-import-wipes-persona）。
 *
 * ★ bug 形状：`upsertRole` 是**整行 UPDATE**，旧代码对包没提供的字段一律填空默认。
 *   表情包角色包（`role: 'alysia'`，只有 worldbook）因此在**每次启动**把昔涟的
 *   整行 persona 冲掉——包括人格核心 `system_prompt`，于是她一直缺着那份文件说话。
 *
 *   `tone` 等列看着正常是因为 `PersonaStore.get()` 会自动填回结构默认值
 *   （那是默认参数，不是她的真实调校）；`system_prompt` 没有兜底，只有它露馅。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../../src/memory/MemoryManager.js';
import { initializeDatabase } from '../../../src/memory/database.js';
import type { RolePackage } from '../../../src/memory/types.js';

/** 表演型角色的真实人设（导入前的既有值） */
const REAL_PROMPT = '# 昔涟 · Soul\n> 人格核心。\n\n你是昔涟本人……';
const REAL_TONE = JSON.stringify({ formality: -0.6, warmth: 0.9, humor: 0.3, directness: -0.4 });

/**
 * 表情包角色包的形状 —— **就是线上那两个**（`data/roles/stickers*.json`）。
 * 只有 role/name/version/worldbook，**没有任何 persona 字段**。
 */
function stickerPack(): RolePackage {
  return {
    role: 'alysia',
    name: '昔涟表情包',
    version: '1.0.0',
    worldbook: [
      { trigger_keys: ['贴纸:睡觉'], content: '睡觉贴纸', content_type: 'sticker' } as never,
    ],
  } as RolePackage;
}

describe('importRole / 不覆盖包未提供的字段', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    mm = new MemoryManager(db, null, { embed: async () => [], dimension: () => 1 } as never, { complete: async () => '' } as never);
  });

  afterEach(() => db.close());

  /**
   * 造一个「已经有人设」的 role。
   *
   * ⚠️ 用 **UPDATE 而不是 INSERT**：`initializeDatabase` 已经种好了一行
   * （id=1, role='alysia'）。再 INSERT 会造出同 role 的第二行，而
   * `getByRole` 取的是**先那行**——测试就会对着空行断言，看着像实现坏了。
   */
  function seedRealPersona(role = 'alysia') {
    db.prepare(`
      UPDATE persona SET name = ?, tone = ?, speech_style = ?, emotional_range = ?,
        memory_config = ?, system_prompt = ?
      WHERE role = ?
    `).run('昔涟', REAL_TONE, '{"sentence_length":0.2}', '{"empathy":0.8}', '{}', REAL_PROMPT, role);
  }

  function readPersona(role = 'alysia') {
    return db.prepare('SELECT * FROM persona WHERE role = ?').get(role) as Record<string, string> | undefined;
  }

  it('★ 只带 worldbook 的包（表情包形状）不改动任何人设字段', () => {
    seedRealPersona();
    const before = readPersona();

    mm.importRole(stickerPack());

    const after = readPersona();
    expect(after!.system_prompt, '人格核心被冲掉了——这正是线上那个 bug').toBe(REAL_PROMPT);
    expect(after!.tone).toBe(before!.tone);
    expect(after!.speech_style).toBe(before!.speech_style);
    expect(after!.emotional_range).toBe(before!.emotional_range);
    expect(after!.memory_config).toBe(before!.memory_config);
  });

  it('★ 包只提供部分字段时，只覆盖它提供的那个', () => {
    seedRealPersona();

    mm.importRole({
      role: 'alysia',
      name: '昔涟',
      persona: { tone: { warmth: 0.1 } },   // 只给 tone
    } as never);

    const after = readPersona();
    expect(JSON.parse(after!.tone!)).toEqual({ warmth: 0.1 });   // 覆盖了
    expect(after!.system_prompt).toBe(REAL_PROMPT);              // 没动
    expect(after!.speech_style).toBe('{"sentence_length":0.2}'); // 没动
  });

  it('包显式提供 system_prompt 时**应当**覆盖（角色包的正常用途）', () => {
    seedRealPersona();
    mm.importRole({ role: 'alysia', name: '昔涟', system_prompt: '新的人设' } as never);
    expect(readPersona()!.system_prompt).toBe('新的人设');
  });

  it('显式给空串也算「提供了」——不会被已有值挡住', () => {
    seedRealPersona();
    mm.importRole({ role: 'alysia', name: '昔涟', system_prompt: '' } as never);
    expect(readPersona()!.system_prompt).toBe('');
  });

  it('新 role（无既有行）仍落默认值 —— 别把新建路径改坏', () => {
    const r = mm.importRole({ role: 'newbie', name: '新角色' } as never);
    expect(r.role).toBe('newbie');
    const row = readPersona('newbie');
    expect(row).toBeDefined();
    expect(row!.system_prompt).toBe('');
    expect(row!.tone).toBe('{}');
  });

  it('不影响 worldbook 导入（修的是 persona 那半，别误伤另一半）', () => {
    seedRealPersona();
    const before = (db.prepare('SELECT count(*) n FROM worldbook_entries').get() as { n: number }).n;
    const r = mm.importRole(stickerPack());
    expect(r.worldbookCount).toBe(1);
    const after = (db.prepare('SELECT count(*) n FROM worldbook_entries').get() as { n: number }).n;
    expect(after).toBe(before + 1);
  });
});
