// tests/memory/unit/PersonaStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PersonaStore } from '../../../src/memory/stores/PersonaStore';
import { initializeDatabase } from '../../../src/memory/database';

describe('PersonaStore', () => {
  let db: Database.Database;
  let store: PersonaStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new PersonaStore(db);
    // Seed with default row
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at) VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}', '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}', '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
  });

  afterEach(() => db.close());

  // ── v3 角色系统 ─────────────────────────────────────

  it('should upsert and switch roles', () => {
    store.upsertRole({
      role: 'test-role',
      name: '测试角色',
      tone: '{"formality":0.5}',
      speech_style: '{"sentence_length":0.5}',
      emotional_range: '{"expressiveness":0.5}',
      memory_config: '{"retention_bias":0,"decay_rate":0.5,"importance_threshold":0.5,"recency_weight":0.5,"confirmation_bias":0.5}',
      system_prompt: '测试角色人格提示词',
      is_active: true,
    });

    // 切换到新角色
    expect(store.setActive('test-role')).toBe(true);
    const active = store.get();
    expect(active.name).toBe('测试角色');
    expect(active.system_prompt).toBe('测试角色人格提示词');
    expect(active.role).toBe('test-role');

    // 列表包含两个角色
    const roles = store.listAll();
    expect(roles).toHaveLength(2);
    expect(roles.find(r => r.role === 'test-role')?.isActive).toBe(true);
    expect(roles.find(r => r.role === 'alysia')?.isActive).toBe(false);
  });

  it('should reject switching to non-existent role', () => {
    expect(store.setActive('ghost')).toBe(false);
  });

  it('should get role by id', () => {
    store.upsertRole({
      role: 'r2',
      name: '角色二',
      tone: '{}', speech_style: '{}', emotional_range: '{}',
      memory_config: '{"retention_bias":0,"decay_rate":0.5,"importance_threshold":0.5,"recency_weight":0.5,"confirmation_bias":0.5}',
      system_prompt: '',
    });
    expect(store.getByRole('r2')?.name).toBe('角色二');
    expect(store.getByRole('missing')).toBeNull();
  });

  it('should return default persona on first read', () => {
    const persona = store.get();
    expect(persona.name).toBe('昔涟');
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBe(0);
  });

  it('should update tone', () => {
    store.updateTone('{"formality":-0.5,"warmth":0.8,"humor":0.3,"directness":0.1}');
    const parsed = JSON.parse(store.get().tone);
    expect(parsed.formality).toBe(-0.5);
    expect(parsed.warmth).toBe(0.8);
  });

  it('should update speech style', () => {
    store.updateSpeechStyle('{"sentence_length":0.5,"emoji_usage":0.8,"code_heavy":-0.3}');
    const parsed = JSON.parse(store.get().speech_style);
    expect(parsed.emoji_usage).toBe(0.8);
  });

  it('should update emotional range', () => {
    store.updateEmotionalRange('{"expressiveness":0.7,"empathy":0.5,"playfulness":0.4}');
    const parsed = JSON.parse(store.get().emotional_range);
    expect(parsed.expressiveness).toBe(0.7);
  });

  it('should add and retrieve adaptation hints', () => {
    store.addAdaptationHint({
      trigger: 'user_said_too_formal',
      adjustment: { 'tone.formality': -0.15 },
      evidence: 'evt-1',
      applied_at: new Date().toISOString(),
    });
    const hints = store.getAdaptationHints();
    expect(hints).toHaveLength(1);
    expect(hints[0].trigger).toBe('user_said_too_formal');
  });

  it('should update name', () => {
    store.setName('小明');
    expect(store.get().name).toBe('小明');
  });
});

describe('PersonaStore — 8-09 空值修复', () => {
  let db: Database.Database;
  let store: PersonaStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new PersonaStore(db);
  });

  afterEach(() => { db.close(); });

  it('已有行 tone={}（历史遗留）→ get() 时自动补默认参数', () => {
    store.get(); // 触发 ensureRow 建行
    db.prepare('UPDATE persona SET tone = ? WHERE is_active = 1').run('{}');
    const persona = store.get(); // 再读 → ensureRow 修复
    expect(JSON.parse(persona.tone).formality).toBe(0);
    expect(JSON.parse(persona.tone)).toHaveProperty('warmth');
    expect(JSON.parse(persona.speech_style)).toHaveProperty('sentence_length');
    expect(JSON.parse(persona.emotional_range)).toHaveProperty('empathy');
  });
});

// ─────────────────────────────────────────────────────────────
// ★ 第三批（2026-10-16）· KI-22：**写入侧**保证最多一个激活行
//
// 旧实现 `upsertRole` 用 `is_active = CASE WHEN ? = 1 THEN 1 ELSE is_active END`
// —— **只置位、不清别人**。于是 `upsertRole(..., is_active: true)` 会留下**双激活行**。
//
// 为什么现在没爆：`upsertRole` 全仓只有一个调用方 `MemoryManager.importRole`，
// 而它在同一个函数里、约 50 行后紧跟 `setActive(pkg.role)`，中间全是同步代码
// ⇒ 双激活窗口在同一 tick 内被"顺手"修好，**外部观测不到**。
// ⚠️ 靠的是**调用顺序**，不是任何不变量 —— 下一个调用方就会真的留下双激活行，
//    而症状是「人格改了没生效 / 随机漂移」，很难查。
// ─────────────────────────────────────────────────────────────

describe('★ KI-22 写入侧:最多一个激活角色', () => {
  let db: Database.Database;
  let store: PersonaStore;

  const ROLE_INPUT = {
    role: 'r-extra',
    name: '额外角色',
    tone: '{}', speech_style: '{}', emotional_range: '{}',
    memory_config: '{"retention_bias":0,"decay_rate":0.5,"importance_threshold":0.5,"recency_weight":0.5,"confirmation_bias":0.5}',
    system_prompt: '',
  };

  const activeRoles = (): string[] =>
    (db.prepare('SELECT role FROM persona WHERE is_active = 1 ORDER BY role').all() as Array<{ role: string }>)
      .map(r => r.role);

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new PersonaStore(db);
    store.get();   // 触发 ensureRow：默认角色 alysia 是 active
  });
  afterEach(() => { db.close(); });

  it('★★ 主症：upsertRole(is_active:true) 必须清掉旧的主动行（不能只置位）', () => {
    store.upsertRole({ ...ROLE_INPUT, is_active: true });

    expect(activeRoles(), 'upsertRole 留下了双激活行 —— 读一个写两个').toEqual(['r-extra']);
  });

  it('★ 同样地：把已存在的角色激活，也要清旧的主动行', () => {
    store.upsertRole({ ...ROLE_INPUT, is_active: false });          // 先建成非激活
    expect(activeRoles()).toEqual(['alysia']);

    store.upsertRole({ ...ROLE_INPUT, is_active: true });           // 再激活（走 UPDATE 分支）

    expect(activeRoles(), 'UPDATE 分支同样会留下双激活').toEqual(['r-extra']);
  });

  it('★ is_active 不传 / false → 不动现有的激活状态（回归：别把不激活也清了）', () => {
    store.upsertRole({ ...ROLE_INPUT });
    expect(activeRoles()).toEqual(['alysia']);
  });

  // ⚠️ 这条是**回归守卫**，不是复现测试：SQLite 对简单扫描通常按 rowid 返回，
  //    所以旧代码（无 ORDER BY）在这里**也可能碰巧通过**。
  //    它锁的是「双激活已不可能产生时，读侧仍有确定的选择」这条兜底契约。
  it('★ 守卫：即使历史数据里存在双激活行，get() 也必须**确定**（ORDER BY id 兜底）', () => {
    store.upsertRole({ ...ROLE_INPUT, is_active: false });
    db.prepare('UPDATE persona SET is_active = 1').run();   // 直接造出双激活（模拟历史脏数据）

    const picked = store.get().role;
    for (let i = 0; i < 5; i++) {
      expect(store.get().role, 'get() 在双激活下选择了不确定的行').toBe(picked);
    }
    // ORDER BY id → 取 id 最小的那行（内置角色 alysia 是 id=1）
    expect(picked).toBe('alysia');
  });
});
