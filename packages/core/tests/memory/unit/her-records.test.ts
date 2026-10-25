/**
 * 「她的叙述记录」一张表 —— 存储与兼容层（★ 2026-10-25，change: `her-records-one-table`）
 *
 * 合并的三样：公开日记 / 私密日记 / 反思正文。它们是**同一类**：
 * "某一天、一段她自己写的第一人称叙述"，只有**读者**（visibility）与**生命周期**不同。
 *
 * 这个文件守：
 * 1. `saveRecord` 的"一天一篇"覆盖语义（同 kind+visibility+date 覆盖，不新增行）
 * 2. `listRecords` 的过滤（kind / visibility）—— 私密本绝不能混进"公开"查询
 * 3. **兼容层**：老的 `saveDiary/listDiaries/getDiary/getLastDiaryTail` 全部走新表，行为不变
 * 4. 反思正文从"覆盖"变"逐日累积"（这正是它以前白写的原因）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database';
import { LifeStore } from '../../../src/memory/stores/LifeStore';

describe('ai_life_records —— 一天一篇 + 过滤', () => {
  let db: Database.Database;
  let store: LifeStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new LifeStore(db);
  });
  afterEach(() => db.close());

  const count = () => (db.prepare('SELECT COUNT(*) n FROM ai_life_records').get() as any).n;

  it('★ 同一天重复写 = 覆盖（不是新增一行）', () => {
    store.saveRecord({ kind: 'diary', visibility: 'private', date: '2026-10-24', content: '第一版' });
    store.saveRecord({ kind: 'diary', visibility: 'private', date: '2026-10-24', content: '第二版' });
    expect(count()).toBe(1);
    expect(store.listRecords({ kind: 'diary', visibility: 'private' })[0].content).toBe('第二版');
  });

  it('★ 同一天可以同时有公开本与私密本（不会互相覆盖）', () => {
    store.saveRecord({ kind: 'diary', visibility: 'shared', date: '2026-10-24', content: '给他看的' });
    store.saveRecord({ kind: 'diary', visibility: 'private', date: '2026-10-24', content: '不加滤镜的' });
    expect(count()).toBe(2);
    expect(store.listRecords({ kind: 'diary', visibility: 'shared' })[0].content).toBe('给他看的');
    expect(store.listRecords({ kind: 'diary', visibility: 'private' })[0].content).toBe('不加滤镜的');
  });

  it('★ 私密本不会出现在"公开"查询里', () => {
    store.saveRecord({ kind: 'diary', visibility: 'private', date: '2026-10-24', content: '秘密' });
    expect(store.listRecords({ kind: 'diary', visibility: 'shared' })).toHaveLength(0);
    expect(store.listRecords({ visibility: 'shared' })).toHaveLength(0);
  });

  it('按日期倒序，limit 生效', () => {
    for (const d of ['2026-10-21', '2026-10-22', '2026-10-23']) {
      store.saveRecord({ kind: 'diary', visibility: 'private', date: d, content: d });
    }
    const rows = store.listRecords({ kind: 'diary', visibility: 'private', limit: 2 });
    expect(rows.map(r => r.date)).toEqual(['2026-10-23', '2026-10-22']);
  });

  it('★ 反思正文可以逐日累积（以前是覆盖，写了 11 天全白写）', () => {
    store.saveRecord({ kind: 'reflection', visibility: 'private', date: '2026-10-23', content: '第一天' });
    store.saveRecord({ kind: 'reflection', visibility: 'private', date: '2026-10-24', content: '第二天' });
    expect(store.listRecords({ kind: 'reflection', visibility: 'private' })).toHaveLength(2);
  });

  it('lastRecordTail 取最近一篇的最后一句（新日记要接上它）', () => {
    store.saveRecord({ kind: 'diary', visibility: 'private', date: '2026-10-24', content: '第一句。第二句。最后一句。' });
    expect(store.lastRecordTail('diary', 'private')).toBe('最后一句。');
  });
});

describe('兼容层：老日记 API 全部改走新表', () => {
  let db: Database.Database;
  let store: LifeStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new LifeStore(db);
  });
  afterEach(() => db.close());

  it('★ saveDiary 写进 ai_life_records（不再是 ai_life_diaries）', () => {
    store.saveDiary({ date: '2026-10-24', content: '公开日记', mood: '平静', moodValue: 3 });
    const legacy = (db.prepare('SELECT COUNT(*) n FROM ai_life_diaries').get() as any).n;
    const fresh = (db.prepare('SELECT COUNT(*) n FROM ai_life_records').get() as any).n;
    expect(legacy, '旧表不该再被写').toBe(0);
    expect(fresh).toBe(1);
  });

  it('★ getDiary / listDiaries / getLastDiaryTail 行为不变', () => {
    store.saveDiary({ date: '2026-10-24', content: '第一句。最后一句。' });
    expect(store.getDiary('2026-10-24')?.content).toBe('第一句。最后一句。');
    expect(store.listDiaries(10)).toHaveLength(1);
    expect(store.getLastDiaryTail()).toBe('最后一句。');
  });

  it('旧表里有数据、新表为空时仍读得到（迁移前的回落）', () => {
    db.prepare(`INSERT INTO ai_life_diaries (date, content, mood, mood_value, created_at)
      VALUES ('2026-10-01', '老数据。', '', 0, '2026-10-01T00:00:00Z')`).run();
    expect(store.getDiary('2026-10-01')?.content).toBe('老数据。');
    expect(store.listDiaries(10)[0].content).toBe('老数据。');
    expect(store.getLastDiaryTail()).toBe('老数据。');
  });
});
