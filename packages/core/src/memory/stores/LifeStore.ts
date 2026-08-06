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
}

export interface LifeState {
  currentActivity: string;
  mood: string;
  intimacy: number;
  lastEventId: string | null;
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
      lastEventId: (row?.last_event_id as string) ?? null,
      updatedAt: (row?.updated_at as string) ?? '',
    };
  }

  updateState(partial: { currentActivity?: string; mood?: string; intimacy?: number; lastEventId?: string }): void {
    this.ensureState();
    const now = new Date().toISOString();
    const s = this.getState();
    const cur = {
      current_activity: partial.currentActivity ?? s.currentActivity,
      mood: partial.mood ?? s.mood,
      intimacy: partial.intimacy ?? s.intimacy,
      last_event_id: partial.lastEventId ?? s.lastEventId,
    };
    this.db.prepare('UPDATE ai_life_state SET current_activity = ?, mood = ?, intimacy = ?, last_event_id = ?, updated_at = ? WHERE id = 1')
      .run(cur.current_activity, cur.mood, cur.intimacy, cur.last_event_id, now);
  }

  addEvent(e: { id: string; createdAt: string; type: 'chat' | 'internal'; content: string; moodDelta?: string; referenceEventId?: string; wbEntryId?: string; delivered?: number }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO ai_life_events (id, created_at, type, content, mood_delta, reference_event_id, wb_entry_id, delivered)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.id, e.createdAt, e.type, e.content, e.moodDelta ?? null, e.referenceEventId ?? null, e.wbEntryId ?? null, e.delivered ?? 0);
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
    };
  }
}
