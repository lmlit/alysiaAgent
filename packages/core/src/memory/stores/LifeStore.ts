// src/memory/stores/LifeStore.ts
// AI 主动生活系统数据层：实时状态 + 事件流 + 每日摘要
import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export interface LifeEvent {
  id: string;
  createdAt: string;
  type: 'chat' | 'internal';
  content: string;
  moodDelta?: string;
  referenceEventId?: string;
  wbEntryId?: string;
  delivered: number;
  /** ★ 8-27 事件来源：'regular'(常规) | 'followup'(对话余波，不推送只记录) */
  origin?: 'regular' | 'followup';
}

export interface LifeState {
  currentActivity: string;
  mood: string;
  intimacy: number;
  /** ★ 8-27 情绪累积值 -100..100（同向加成/反向衰减/8h 回归 0） */
  moodValue: number;
  lastEventId: string | null;
  updatedAt: string;
}

/** ★ 8-27 配角在场状态（HDSI ScenePresence 简化版） */
export interface ScenePresence {
  name: string;
  status: 'present' | 'off-scene' | 'expected';
  basis?: string;
  updatedAt: string;
}

export class LifeStore {
  constructor(private db: Database.Database) {}

  private ensureState(): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO ai_life_state (id, current_activity, mood, intimacy, last_event_id, updated_at)
      VALUES (1, '', '', 30, NULL, ?)
    `).run(new Date().toISOString());
  }

  getState(): LifeState {
    this.ensureState();
    const row = this.db.prepare('SELECT * FROM ai_life_state WHERE id = 1').get() as Record<string, unknown> | undefined;
    return {
      currentActivity: (row?.current_activity as string) ?? '',
      mood: (row?.mood as string) ?? '',
      intimacy: (row?.intimacy as number) ?? 30,
      moodValue: (row?.mood_value as number) ?? 0,
      lastEventId: (row?.last_event_id as string) ?? null,
      updatedAt: (row?.updated_at as string) ?? '',
    };
  }

  updateState(partial: { currentActivity?: string; mood?: string; intimacy?: number; moodValue?: number; lastEventId?: string }): void {
    this.ensureState();
    const now = new Date().toISOString();
    const s = this.getState();
    const cur = {
      current_activity: partial.currentActivity ?? s.currentActivity,
      mood: partial.mood ?? s.mood,
      intimacy: partial.intimacy ?? s.intimacy,
      mood_value: partial.moodValue ?? s.moodValue,
      last_event_id: partial.lastEventId ?? s.lastEventId,
    };
    this.db.prepare('UPDATE ai_life_state SET current_activity = ?, mood = ?, intimacy = ?, mood_value = ?, last_event_id = ?, updated_at = ? WHERE id = 1')
      .run(cur.current_activity, cur.mood, cur.intimacy, cur.mood_value, cur.last_event_id, now);
  }

  addEvent(e: { id: string; createdAt: string; type: 'chat' | 'internal'; content: string; moodDelta?: string; referenceEventId?: string; wbEntryId?: string; delivered?: number; origin?: 'regular' | 'followup' }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO ai_life_events (id, created_at, type, content, mood_delta, reference_event_id, wb_entry_id, delivered, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.id, e.createdAt, e.type, e.content, e.moodDelta ?? null, e.referenceEventId ?? null, e.wbEntryId ?? null, e.delivered ?? 0, e.origin ?? 'regular');
    logger.debug(`[Life] event stored: ${e.content.slice(0, 40)}`);
  }

  getTodayEvents(todayKey: string): LifeEvent[] {
    return this.getEventsSince(`${todayKey}T00:00:00`);
  }

  getEventsSince(isoStart: string): LifeEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM ai_life_events WHERE created_at >= ? ORDER BY created_at ASC'
    ).all(isoStart) as Record<string, unknown>[];
    return rows.map(r => this.rowToEvent(r));
  }

  getEventById(id: string): LifeEvent | null {
    const row = this.db.prepare('SELECT * FROM ai_life_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToEvent(row) : null;
  }

  markDelivered(id: string): void {
    this.db.prepare('UPDATE ai_life_events SET delivered = 1 WHERE id = ?').run(id);
  }

  upsertDailySummary(date: string, summary: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO ai_life_daily_summaries (date, summary, created_at)
      VALUES (?, ?, ?)
    `).run(date, summary, new Date().toISOString());
  }

  getRecentSummaries(days: number): Array<{ date: string; summary: string }> {
    const rows = this.db.prepare(
      'SELECT date, summary FROM ai_life_daily_summaries ORDER BY date DESC LIMIT ?'
    ).all(days) as Array<{ date: string; summary: string }>;
    return rows.reverse(); // 旧 → 新
  }

  // ── ★ 8-14 生活模板池（content-self-evolution）──────────────────────────────
  //   源 server/life-templates.ts const → 本表；'seed' 种子 + 'self' 昔涟自写

  addTemplate(t: { id: string; activity: string; type: 'chat' | 'internal'; weight: number; source: 'seed' | 'self'; createdAt: string; category?: string; groupName?: string }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO life_templates (id, activity, type, weight, source, created_at, category, group_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(t.id, t.activity, t.type, t.weight, t.source, t.createdAt, t.category ?? '独处', t.groupName ?? 'none');
  }

  listTemplates(): Array<{ id: string; activity: string; type: 'chat' | 'internal'; weight: number; source: string; category: string; groupName: string }> {
    const rows = this.db.prepare('SELECT * FROM life_templates ORDER BY created_at ASC').all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      activity: r.activity as string,
      type: r.type as 'chat' | 'internal',
      weight: r.weight as number,
      source: (r.source as string) ?? 'seed',
      category: (r.category as string) ?? '独处',
      groupName: (r.group_name as string) ?? 'none',
    }));
  }

  deleteTemplate(id: string): boolean {
    return this.db.prepare('DELETE FROM life_templates WHERE id = ?').run(id).changes > 0;
  }

  // ── ★ 8-27 配角在场（ScenePresence）──────────────────────────────────

  /** 全部在场状态（present/expected 优先；off-scene 也返回供注入说明） */
  listScenePresence(): ScenePresence[] {
    const rows = this.db.prepare('SELECT * FROM ai_life_scene_presence ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map(r => ({
      name: r.name as string,
      status: (r.status as ScenePresence['status']) ?? 'off-scene',
      basis: (r.basis as string) ?? undefined,
      updatedAt: r.updated_at as string,
    }));
  }

  /** 当前在场配角名（present + expected）——事件生成注入【在场角色】用 */
  listPresentNames(): string[] {
    const rows = this.db.prepare(
      "SELECT name FROM ai_life_scene_presence WHERE status IN ('present', 'expected') ORDER BY updated_at DESC"
    ).all() as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  /** 更新/新建在场状态（事件提到谁 → present，带依据） */
  upsertScenePresence(name: string, status: ScenePresence['status'], basis?: string): void {
    this.db.prepare(`
      INSERT INTO ai_life_scene_presence (name, status, basis, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET status = excluded.status, basis = excluded.basis, updated_at = excluded.updated_at
    `).run(name, status, basis ?? null, new Date().toISOString());
  }

  /** 在场超时判定用：在场角色多久没更新了（小时） */
  presenceStaleHours(name: string, now: number = Date.now()): number | null {
    const row = this.db.prepare('SELECT updated_at FROM ai_life_scene_presence WHERE name = ?').get(name) as { updated_at: string } | undefined;
    if (!row) return null;
    return (now - new Date(row.updated_at).getTime()) / 3_600_000;
  }

  private rowToEvent(r: Record<string, unknown>): LifeEvent {
    return {
      id: r.id as string,
      createdAt: r.created_at as string,
      type: r.type as 'chat' | 'internal',
      content: r.content as string,
      moodDelta: (r.mood_delta as string) ?? undefined,
      referenceEventId: (r.reference_event_id as string) ?? undefined,
      wbEntryId: (r.wb_entry_id as string) ?? undefined,
      delivered: (r.delivered as number) ?? 0,
      origin: (r.origin as LifeEvent['origin']) ?? 'regular',
    };
  }
}
