import type Database from 'better-sqlite3';
import type { WorldbookEntry } from '../types';

export class WorldbookStore {
  constructor(private db: Database.Database) {}

  insert(entry: WorldbookEntry): void {
    this.db.prepare(`
      INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.id, entry.trigger_keys, entry.trigger_mode, entry.content, entry.scope, entry.priority, entry.cooldown_sec, entry.last_triggered, entry.hit_count, entry.created_at, entry.updated_at);
  }

  getById(id: string): WorldbookEntry | null {
    const row = this.db.prepare('SELECT * FROM worldbook_entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  matchByKeywords(keywords: string[], scope?: string): WorldbookEntry[] {
    // Fetch all entries matching any keyword (OR logic initially)
    let query = 'SELECT * FROM worldbook_entries WHERE ';
    const conditions: string[] = [];
    const params: string[] = [];

    const likePatterns = keywords.map(k => `%${k}%`);
    const keyConditions = likePatterns.map(() => "trigger_keys LIKE ?").join(' OR ');
    conditions.push(`(${keyConditions})`);
    params.push(...likePatterns);

    if (scope) {
      conditions.push("(scope = ? OR scope = 'both')");
      params.push(scope);
    }

    query += conditions.join(' AND ');
    query += ' ORDER BY priority DESC';

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    let entries = rows.map(r => this.rowToEntry(r));

    // For 'all' mode entries, require every keyword to match (AND logic)
    entries = entries.filter(e => {
      if (e.trigger_mode !== 'all') return true;
      // All keywords must appear in the trigger_keys string
      return keywords.every(k => e.trigger_keys.toLowerCase().includes(k.toLowerCase()));
    });

    // For 'regex' mode entries, trigger_keys is a regex pattern — currently unsupported, skip
    entries = entries.filter(e => e.trigger_mode !== 'regex');

    // Filter out items still on cooldown
    const now = new Date();
    return entries.filter(e => {
      if (!e.last_triggered) return true;
      const triggeredAt = new Date(e.last_triggered);
      return (now.getTime() - triggeredAt.getTime()) > e.cooldown_sec * 1000;
    });
  }

  recordTrigger(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE worldbook_entries SET last_triggered = ?, hit_count = hit_count + 1, updated_at = ? WHERE id = ?'
    ).run(now, now, id);
  }

  updateEntry(id: string, updates: Partial<WorldbookEntry>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'id') continue;
      sets.push(`${key} = ?`);
      values.push(value);
    }
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE worldbook_entries SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteEntry(id: string): void {
    this.db.prepare('DELETE FROM worldbook_entries WHERE id = ?').run(id);
  }

  private rowToEntry(row: Record<string, unknown>): WorldbookEntry {
    return {
      id: row.id as string,
      trigger_keys: row.trigger_keys as string,
      trigger_mode: row.trigger_mode as string,
      content: row.content as string,
      scope: row.scope as string,
      priority: row.priority as number,
      cooldown_sec: row.cooldown_sec as number,
      last_triggered: row.last_triggered as string | null,
      hit_count: row.hit_count as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
