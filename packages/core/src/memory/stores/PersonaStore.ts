// src/memory/stores/PersonaStore.ts
import type Database from 'better-sqlite3';
import type { Persona, MemoryConfig } from '../types.js';

export const DEFAULT_MEMORY_CONFIG_JSON = '{"retention_bias":0.2,"decay_rate":0.3,"importance_threshold":0.4,"recency_weight":0.3,"confirmation_bias":0.3}';
export const DEFAULT_TONE_JSON = '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}';
export const DEFAULT_SPEECH_STYLE_JSON = '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}';
export const DEFAULT_EMOTIONAL_RANGE_JSON = '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}';

export class PersonaStore {
  constructor(private db: Database.Database) {}

  private ensureRow(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, memory_config, adaptation_hints, updated_at, role, is_active)
      VALUES (1, '昔涟', '${DEFAULT_TONE_JSON}', '${DEFAULT_SPEECH_STYLE_JSON}', '${DEFAULT_EMOTIONAL_RANGE_JSON}', '${DEFAULT_MEMORY_CONFIG_JSON}', '[]', ?, 'alysia', 1)
    `).run(now);
    // ★ 8-09 修复：已有行人格参数为空/{}（历史遗留，如 8-09 云端实测 tone='{}'）→ 补默认值。
    //   INSERT OR IGNORE 不更新已有行，旧数据空值导致 PromptAssembler 输出 undefined
    const row = this.db.prepare('SELECT tone, speech_style, emotional_range FROM persona WHERE is_active = 1').get() as
      { tone?: string; speech_style?: string; emotional_range?: string } | undefined;
    if (row) {
      const isEmpty = (v?: string) => !v || v === '{}' || v === '[]' || v === 'null';
      if (isEmpty(row.tone)) this.db.prepare('UPDATE persona SET tone = ? WHERE is_active = 1').run(DEFAULT_TONE_JSON);
      if (isEmpty(row.speech_style)) this.db.prepare('UPDATE persona SET speech_style = ? WHERE is_active = 1').run(DEFAULT_SPEECH_STYLE_JSON);
      if (isEmpty(row.emotional_range)) this.db.prepare('UPDATE persona SET emotional_range = ? WHERE is_active = 1').run(DEFAULT_EMOTIONAL_RANGE_JSON);
    }
  }

  /** 向后兼容：旧数据库可能没有 memory_config 列 */
  migrateMemoryConfig(): void {
    try {
      this.db.exec(`ALTER TABLE persona ADD COLUMN memory_config TEXT NOT NULL DEFAULT '${DEFAULT_MEMORY_CONFIG_JSON}'`);
    } catch {
      // 列已存在，忽略
    }
  }

  /** 获取当前激活角色（无激活行时 fallback 到 id=1 内置角色） */
  get(): Persona {
    this.ensureRow();
    this.migrateMemoryConfig();
    const row = this.db.prepare('SELECT * FROM persona WHERE is_active = 1 LIMIT 1').get() as Persona | undefined;
    if (row) return row;
    return this.db.prepare('SELECT * FROM persona WHERE id = 1').get() as Persona;
  }

  /** 按 role 获取角色 */
  getByRole(role: string): Persona | null {
    const row = this.db.prepare('SELECT * FROM persona WHERE role = ?').get(role) as Persona | undefined;
    return row ?? null;
  }

  /** 切换激活角色（事务：清旧 + 设新） */
  setActive(role: string): boolean {
    const target = this.getByRole(role);
    if (!target) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE persona SET is_active = 0 WHERE is_active = 1').run();
      this.db.prepare('UPDATE persona SET is_active = 1 WHERE role = ?').run(role);
    });
    tx();
    return true;
  }

  /** 角色列表 */
  listAll(): Array<{ role: string; name: string; isActive: boolean; updated_at: string }> {
    const rows = this.db.prepare('SELECT role, name, is_active, updated_at FROM persona ORDER BY is_active DESC, id ASC').all() as Array<{ role: string; name: string; is_active: number; updated_at: string }>;
    return rows.map(r => ({ role: r.role, name: r.name, isActive: r.is_active === 1, updated_at: r.updated_at }));
  }

  /** 插入或更新角色（角色包导入用）。role 冲突时覆盖。 */
  upsertRole(input: {
    role: string;
    name: string;
    tone: string;
    speech_style: string;
    emotional_range: string;
    memory_config: string;
    system_prompt: string;
    is_active?: boolean;
  }): void {
    this.ensureRow();
    const now = new Date().toISOString();
    const existing = this.getByRole(input.role);
    if (existing) {
      this.db.prepare(`
        UPDATE persona SET name = ?, tone = ?, speech_style = ?, emotional_range = ?,
          memory_config = ?, system_prompt = ?, updated_at = ?,
          is_active = CASE WHEN ? = 1 THEN 1 ELSE is_active END
        WHERE role = ?
      `).run(input.name, input.tone, input.speech_style, input.emotional_range,
        input.memory_config, input.system_prompt, now,
        input.is_active ? 1 : 0, input.role);
    } else {
      this.db.prepare(`
        INSERT INTO persona (name, tone, speech_style, emotional_range, memory_config, system_prompt, adaptation_hints, updated_at, role, is_active)
        VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
      `).run(input.name, input.tone, input.speech_style, input.emotional_range,
        input.memory_config, input.system_prompt, now, input.role,
        input.is_active ? 1 : 0);
    }
  }

  // ===== 记忆人格旋钮 =====

  getMemoryConfig(): MemoryConfig {
    const persona = this.get();
    const row = { memory_config: persona.memory_config };
    try {
      return JSON.parse(row.memory_config);
    } catch {
      return JSON.parse(DEFAULT_MEMORY_CONFIG_JSON);
    }
  }

  updateMemoryConfig(config: Partial<MemoryConfig>): void {
    const current = this.getMemoryConfig();
    const updated = { ...current, ...config };
    // 钳制范围 [-1, 1]
    for (const k of Object.keys(updated) as (keyof MemoryConfig)[]) {
      updated[k] = Math.max(-1, Math.min(1, updated[k]));
    }
    this.db.prepare('UPDATE persona SET memory_config = ?, updated_at = ? WHERE is_active = 1')
      .run(JSON.stringify(updated), new Date().toISOString());
  }

  // ===== 原有方法（作用于激活角色）=====

  updateTone(tone: string): void {
    this.db.prepare('UPDATE persona SET tone = ?, updated_at = ? WHERE is_active = 1')
      .run(tone, new Date().toISOString());
  }

  updateSpeechStyle(style: string): void {
    this.db.prepare('UPDATE persona SET speech_style = ?, updated_at = ? WHERE is_active = 1')
      .run(style, new Date().toISOString());
  }

  updateEmotionalRange(range: string): void {
    this.db.prepare('UPDATE persona SET emotional_range = ?, updated_at = ? WHERE is_active = 1')
      .run(range, new Date().toISOString());
  }

  addAdaptationHint(hint: object): void {
    const current = this.getAdaptationHints();
    current.push(hint);
    this.db.prepare('UPDATE persona SET adaptation_hints = ?, updated_at = ? WHERE is_active = 1')
      .run(JSON.stringify(current), new Date().toISOString());
  }

  getAdaptationHints(): object[] {
    const persona = this.get();
    try {
      return JSON.parse(persona.adaptation_hints);
    } catch {
      return [];
    }
  }

  setName(name: string): void {
    this.db.prepare('UPDATE persona SET name = ?, updated_at = ? WHERE is_active = 1')
      .run(name, new Date().toISOString());
  }

  /** 更新激活角色的 system_prompt */
  updateSystemPrompt(prompt: string): void {
    this.db.prepare('UPDATE persona SET system_prompt = ?, updated_at = ? WHERE is_active = 1')
      .run(prompt, new Date().toISOString());
  }
}
