// src/memory/stores/PersonaStore.ts
import type Database from 'better-sqlite3';
import type { Persona, MemoryConfig } from '../types.js';
import { traceZeroRows } from '../../utils/write-trace.js';
import { logger } from '../../utils/logger.js';

export const DEFAULT_MEMORY_CONFIG_JSON = '{"retention_bias":0.2,"decay_rate":0.3,"importance_threshold":0.4,"recency_weight":0.3,"confirmation_bias":0.3}';
export const DEFAULT_TONE_JSON = '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}';
export const DEFAULT_SPEECH_STYLE_JSON = '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}';
export const DEFAULT_EMOTIONAL_RANGE_JSON = '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}';

export class PersonaStore {
  constructor(private db: Database.Database) {}

  /**
   * ★ 2026-10-02（change: observe-zero-row-writes）：8 个
   * `UPDATE persona … WHERE is_active = 1` 写点的统一出口 —— **只观测，不改行为**。
   *
   * 为什么单独走一个包装：这类写点最微妙的失效是「**没有激活行**」——
   * 此时 `get()` 会 fallback 到 id=1 内置行，**照样读到一个正常人格**，
   * 而写回 0 行、**不报错、不抛异常**，调用方看到的是"改成功了"。
   * 三件事同时成立，静态读代码看不出来；接上 changes 观测才能拿到分布。
   *
   * 行为与改动前完全一致：仍然只 `.run()`，仍然返回 void。
   */
  private updateActive(tag: string, sql: string, ...params: unknown[]): void {
    const r = this.db.prepare(sql).run(...params);
    traceZeroRows(tag, r.changes, 'WHERE is_active=1 未命中任何行');
  }

  private ensureRow(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, memory_config, adaptation_hints, updated_at, role, is_active)
      VALUES (1, '昔涟', '${DEFAULT_TONE_JSON}', '${DEFAULT_SPEECH_STYLE_JSON}', '${DEFAULT_EMOTIONAL_RANGE_JSON}', '${DEFAULT_MEMORY_CONFIG_JSON}', '[]', ?, 'alysia', 1)
    `).run(now);
    // ★ 2026-10-16（KI-16）：原先这里还有一段「检测到空列就 UPDATE 回默认值」——
    //   **已移出读路径**，见 `repairEmptyColumns()`。ensureRow 现在只做「行不在就种一行」，
    //   不再对**已存在的行**做任何整形。
  }

  /**
   * 读兜底：把空的 tone / speech_style / emotional_range **填进返回值**，绝不写库。
   *
   * ★ 2026-10-16（change: `fix-store-write-trace`，KI-16）：
   *   原实现在 `ensureRow()` 里检测到空列就 `UPDATE` 回结构默认值 ——
   *   于是「人格被冲成空」被**整形成一组合法出厂默认值**（与 seed 逐字相同），
   *   **骗过数据层也骗过人工巡检**，且无日志。而 `get()` 是**读**方法，
   *   调用方根本不知道自己触发了一次写。
   *
   *   契约：**读可以给默认值，但不许把默认值写回去**。
   *   真要修库里的值就走显式入口 `repairEmptyColumns()`（它留痕）。
   */
  private withDefaults(row: Persona): Persona {
    const isEmpty = (v?: string) => !v || v === '{}' || v === '[]' || v === 'null';
    const out = { ...row };
    if (isEmpty(out.tone)) out.tone = DEFAULT_TONE_JSON;
    if (isEmpty(out.speech_style)) out.speech_style = DEFAULT_SPEECH_STYLE_JSON;
    if (isEmpty(out.emotional_range)) out.emotional_range = DEFAULT_EMOTIONAL_RANGE_JSON;
    return out;
  }

  /**
   * **显式**修复被冲空的人格列（不是读路径）。返回被修复的列名。
   *
   * 之所以要留下这个入口：兜底只在内存里生效的话，「库里其实是空的」这件事
   * 就永远不会被说出来 —— 而它正是「人格被冲空」唯一可见的证据。
   * 因此在启动时显式调用一次，**改了就打 warn**。
   */
  repairEmptyColumns(): string[] {
    this.ensureRow();
    const row = this.db.prepare('SELECT tone, speech_style, emotional_range FROM persona WHERE is_active = 1').get() as
      { tone?: string; speech_style?: string; emotional_range?: string } | undefined;
    if (!row) return [];

    const isEmpty = (v?: string) => !v || v === '{}' || v === '[]' || v === 'null';
    const fixes: Array<[string, string, string | undefined]> = [
      ['tone', DEFAULT_TONE_JSON, row.tone],
      ['speech_style', DEFAULT_SPEECH_STYLE_JSON, row.speech_style],
      ['emotional_range', DEFAULT_EMOTIONAL_RANGE_JSON, row.emotional_range],
    ];
    const fixed: string[] = [];
    for (const [col, def, cur] of fixes) {
      if (!isEmpty(cur)) continue;
      this.db.prepare(`UPDATE persona SET ${col} = ? WHERE is_active = 1`).run(def);
      fixed.push(col);
    }
    if (fixed.length > 0) {
      logger.warn(
        `[PersonaStore] 修复被冲空的人格列：${fixed.join(', ')}` +
        `（**读路径不再自动回写**，所以这是唯一能听到这件事的地方）`,
      );
    }
    return fixed;
  }

  /** 获取当前激活角色（无激活行时 fallback 到 id=1 内置角色） */
  get(): Persona {
    this.ensureRow();
    // ★ KI-16：`migrateMemoryConfig()` 调用已删 —— 它是**写探针**（ALTER TABLE），
    //   而同一列的迁移早已在 `initializeDatabase()` 里集中做过（探测式 `addColumnIfMissing`）。
    //   顺带销掉 KI-5 记的那个裸 catch。
    // ★ 第三批（KI-22）兜底：加 `ORDER BY id` ——
    //   双激活只可能来自**历史脏数据**了（写入侧已保证单一激活），但读侧仍要**确定**，
    //   否则「改了这一行、读的却是另一行」这种漂移无法排查。
    const row = this.db.prepare('SELECT * FROM persona WHERE is_active = 1 ORDER BY id LIMIT 1').get() as Persona | undefined;
    if (row) return this.withDefaults(row);
    const fallback = this.db.prepare('SELECT * FROM persona WHERE id = 1').get() as Persona;
    return fallback ? this.withDefaults(fallback) : fallback;
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

  /**
   * 插入或更新角色（角色包导入用）。role 冲突时覆盖。
   *
   * ★ 第三批（2026-10-16）· KI-22：**激活走 `setActive` 的语义**（同事务内**先清后置**）。
   *
   * 旧写法是 `is_active = CASE WHEN ? = 1 THEN 1 ELSE is_active END` —— **只置位、不清别人**，
   * 于是 `upsertRole(..., is_active: true)` 会留下**双激活行**。
   * 而 8 个写点（`updateTone` / `addAdaptationHint` / …）都是
   * `UPDATE persona … WHERE is_active = 1` **无 `LIMIT 1`**，`get()` 又是
   * `… WHERE is_active = 1 LIMIT 1` **无 `ORDER BY`**
   * ⇒ 双激活时**两行一起被改、读只认不确定的一行**：人格演化同时写进两个角色，读却只认一个。
   *
   * 为什么此前没爆：全仓只有一个调用方 `MemoryManager.importRole`，它在约 50 行后
   * 紧跟 `setActive(pkg.role)`，中间全是同步代码 ⇒ 双激活窗口在同一 tick 内被"顺手"修好。
   * ⚠️ 那靠的是**调用顺序**，不是不变量 —— 下一个调用方就会真的留下双激活行。
   *
   * 现在把不变量建在**写入侧**：激活与建/改在**同一个事务**里完成，中途抛错则整体回滚。
   */
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

    const tx = this.db.transaction(() => {
      if (existing) {
        // ⚠️ 这里**不碰 `is_active`** —— 激活统一由下面两行走，避免两处语义分叉
        this.db.prepare(`
          UPDATE persona SET name = ?, tone = ?, speech_style = ?, emotional_range = ?,
            memory_config = ?, system_prompt = ?, updated_at = ?
          WHERE role = ?
        `).run(input.name, input.tone, input.speech_style, input.emotional_range,
          input.memory_config, input.system_prompt, now, input.role);
      } else {
        // 新建一律 `is_active = 0`；需要激活时由下面的"先清后置"统一置位
        this.db.prepare(`
          INSERT INTO persona (name, tone, speech_style, emotional_range, memory_config, system_prompt, adaptation_hints, updated_at, role, is_active)
          VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, 0)
        `).run(input.name, input.tone, input.speech_style, input.emotional_range,
          input.memory_config, input.system_prompt, now, input.role);
      }

      if (input.is_active) {
        // 与 `setActive` 同语义：**先清所有主动行，再置位目标行**
        this.db.prepare('UPDATE persona SET is_active = 0 WHERE is_active = 1').run();
        this.db.prepare('UPDATE persona SET is_active = 1 WHERE role = ?').run(input.role);
      }
    });
    tx();
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
    this.updateActive(
      'PersonaStore.updateMemoryConfig',
      'UPDATE persona SET memory_config = ?, updated_at = ? WHERE is_active = 1',
      JSON.stringify(updated), new Date().toISOString(),
    );
  }

  // ===== 原有方法（作用于激活角色）=====

  updateTone(tone: string): void {
    this.updateActive(
      'PersonaStore.updateTone',
      'UPDATE persona SET tone = ?, updated_at = ? WHERE is_active = 1',
      tone, new Date().toISOString(),
    );
  }

  updateSpeechStyle(style: string): void {
    this.updateActive(
      'PersonaStore.updateSpeechStyle',
      'UPDATE persona SET speech_style = ?, updated_at = ? WHERE is_active = 1',
      style, new Date().toISOString(),
    );
  }

  updateEmotionalRange(range: string): void {
    this.updateActive(
      'PersonaStore.updateEmotionalRange',
      'UPDATE persona SET emotional_range = ?, updated_at = ? WHERE is_active = 1',
      range, new Date().toISOString(),
    );
  }

  addAdaptationHint(hint: object): void {
    const current = this.getAdaptationHints();
    current.push(hint);
    this.updateActive(
      'PersonaStore.updateAdaptationHints',
      'UPDATE persona SET adaptation_hints = ?, updated_at = ? WHERE is_active = 1',
      JSON.stringify(current), new Date().toISOString(),
    );
  }

  getAdaptationHints(): object[] {
    const persona = this.get();
    try {
      return JSON.parse(persona.adaptation_hints);
    } catch {
      return [];
    }
  }

  // ===== ★ 8-29 Overlay（persona-overlay-perspective）=====
  // 证据门槛固化的稳定人格演化备注（多次同向调整才固化，单次不算）——HDSI Overlay 简化

  appendOverlayNote(note: { dimension: string; change: string; evidence: string; appliedAt: string }): void {
    const current = this.getOverlayNotes();
    // 同维度覆盖旧备注（最新演化状态）
    const filtered = current.filter(n => n.dimension !== note.dimension);
    filtered.push(note);
    this.updateActive(
      'PersonaStore.appendOverlayNote',
      'UPDATE persona SET overlay_notes = ?, updated_at = ? WHERE is_active = 1',
      JSON.stringify(filtered.slice(-10)), new Date().toISOString(),
    );
  }

  getOverlayNotes(): Array<{ dimension: string; change: string; evidence: string; appliedAt: string }> {
    const persona = this.get();
    try {
      const raw = JSON.parse((persona as any).overlay_notes ?? '[]') as Array<{ dimension: string; change: string; evidence: string; appliedAt: string }>;
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  setName(name: string): void {
    this.updateActive(
      'PersonaStore.updateName',
      'UPDATE persona SET name = ?, updated_at = ? WHERE is_active = 1',
      name, new Date().toISOString(),
    );
  }

  /** 更新激活角色的 system_prompt */
  updateSystemPrompt(prompt: string): void {
    this.updateActive(
      'PersonaStore.updateSystemPrompt',
      'UPDATE persona SET system_prompt = ?, updated_at = ? WHERE is_active = 1',
      prompt, new Date().toISOString(),
    );
  }
}
