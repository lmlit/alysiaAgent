// tests/memory/unit/PersonaStore-read.test.ts
// ★ 2026-10-16 change: fix-store-write-trace（KI-16）
//
// KI-16：`PersonaStore.get()` 是**读**方法，却在检测到空的 tone/speech_style/emotional_range
//   时**把结构默认值写回 DB**（原实现 `PersonaStore.ts:21-28`，无日志）。
//
//   危害不是"多写一次"，而是它**把「人格被冲成空」整形成一组合法出厂默认值**
//   （与 seed 逐字相同）——骗过数据层，也骗过人工巡检。
//   `fix-role-import-wipes-persona` 只修了 `importRole` 的合并，**没动这一层**，
//   所以下一次"被冲空"依旧只有没兜底的 `system_prompt` 会露馅。
//
// 契约：**读可以给默认值，但不许把默认值写回去**（兜底与回写分离）；
//   真要修就走**显式**方法（`repairEmptyColumns()`），且必须留痕。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database.js';
import {
  PersonaStore,
  DEFAULT_TONE_JSON,
  DEFAULT_SPEECH_STYLE_JSON,
  DEFAULT_EMOTIONAL_RANGE_JSON,
} from '../../../src/memory/stores/PersonaStore.js';
import { logger } from '../../../src/utils/logger.js';

/** 把激活行的几个列冲成"被读坏"的空值形态（8-09 云端实测过 tone='{}'） */
function corrupt(db: Database.Database, cols: string[]): void {
  const sets = cols.map(c => `${c} = '{}'`).join(', ');
  db.prepare(`UPDATE persona SET ${sets} WHERE is_active = 1`).run();
}

function rawCol(db: Database.Database, col: string): string {
  const row = db.prepare(`SELECT ${col} AS v FROM persona WHERE is_active = 1`).get() as { v: string };
  return row.v;
}

describe('PersonaStore.get() — 读时不得回写默认值（KI-16）', () => {
  let db: Database.Database;
  let store: PersonaStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new PersonaStore(db);
    vi.restoreAllMocks();
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('★★ 主症：读到空 tone → 返回值补默认，但**库里仍是空**（旧实现会把它写回去）', () => {
    corrupt(db, ['tone']);

    const p = store.get();

    // ① 调用方拿到的是可用的默认值（读兜底仍然要生效）
    expect(p.tone).toBe(DEFAULT_TONE_JSON);
    // ② 但**数据没有被悄悄整形** —— 这正是「人格被冲空」能被看见的唯一途径
    expect(rawCol(db, 'tone'), '读操作把默认值写回库了 ⇒ 「被冲空」被伪装成「出厂默认」')
      .toBe('{}');
  });

  it('★★ 三个列全空一次读完 → 库里三列**一个都没动**', () => {
    corrupt(db, ['tone', 'speech_style', 'emotional_range']);

    const p = store.get();

    expect(p.tone).toBe(DEFAULT_TONE_JSON);
    expect(p.speech_style).toBe(DEFAULT_SPEECH_STYLE_JSON);
    expect(p.emotional_range).toBe(DEFAULT_EMOTIONAL_RANGE_JSON);
    expect(rawCol(db, 'tone')).toBe('{}');
    expect(rawCol(db, 'speech_style')).toBe('{}');
    expect(rawCol(db, 'emotional_range')).toBe('{}');
  });

  // ⚠️ 这条**不是** KI-16 的复现测试：旧实现在这里也通过（它只改列、不碰 updated_at）。
  //    它是**回归守卫** —— 读操作连 updated_at 都不该动。
  it('读操作不改 updated_at（回归守卫）', () => {
    corrupt(db, ['tone']);
    const before = db.prepare('SELECT updated_at FROM persona WHERE is_active = 1').get() as { updated_at: string };

    for (let i = 0; i < 5; i++) store.get();

    const after = db.prepare('SELECT updated_at FROM persona WHERE is_active = 1').get() as { updated_at: string };
    expect(after.updated_at, '读操作改了 updated_at ⇒ 一定发生了写').toBe(before.updated_at);
  });

  it('列本来就正常 → 原样返回，不误伤', () => {
    const p = store.get();
    expect(p.tone).toBe(DEFAULT_TONE_JSON);
    expect(rawCol(db, 'tone')).toBe(DEFAULT_TONE_JSON);
  });

  it('★ 显式修复是**另一个方法**，会真的写库并留痕', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    corrupt(db, ['tone', 'speech_style']);

    const repaired = store.repairEmptyColumns();

    expect(repaired.sort()).toEqual(['speech_style', 'tone']);
    expect(rawCol(db, 'tone')).toBe(DEFAULT_TONE_JSON);
    expect(rawCol(db, 'speech_style')).toBe(DEFAULT_SPEECH_STYLE_JSON);
    // 显式修复**必须留痕** —— 它正是在说「这里曾被冲空过」
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/tone|repair|修复/);
  });

  it('显式修复在无需修复时是空操作（不写、不喊）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(store.repairEmptyColumns()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
