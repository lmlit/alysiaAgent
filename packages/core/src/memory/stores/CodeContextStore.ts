// src/memory/stores/CodeContextStore.ts
import type Database from 'better-sqlite3';
import type { CodeContext } from '../types';

export class CodeContextStore {
  constructor(private db: Database.Database) {}

  getActive(): CodeContext | null {
    const row = this.db.prepare('SELECT * FROM code_context WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToCtx(row);
  }

  getById(id: string): CodeContext | null {
    const row = this.db.prepare('SELECT * FROM code_context WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToCtx(row);
  }

  upsert(ctx: CodeContext): void {
    this.db.prepare(`
      INSERT INTO code_context (id, project_name, project_path, tech_stack, architecture_notes, recent_changes, decisions, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_name = excluded.project_name,
        project_path = excluded.project_path,
        tech_stack = excluded.tech_stack,
        architecture_notes = excluded.architecture_notes,
        recent_changes = excluded.recent_changes,
        decisions = excluded.decisions,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at
    `).run(ctx.id, ctx.project_name, ctx.project_path, ctx.tech_stack, ctx.architecture_notes, ctx.recent_changes, ctx.decisions, ctx.is_active, ctx.created_at, ctx.updated_at);
  }

  addDecision(id: string, decision: object): void {
    const ctx = this.getById(id);
    if (!ctx) return;
    const decisions = JSON.parse(ctx.decisions);
    decisions.push(decision);
    this.db.prepare('UPDATE code_context SET decisions = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(decisions), new Date().toISOString(), id);
  }

  updateRecentChanges(id: string, changes: string): void {
    this.db.prepare('UPDATE code_context SET recent_changes = ?, updated_at = ? WHERE id = ?')
      .run(changes, new Date().toISOString(), id);
  }

  deactivate(id: string): void {
    this.db.prepare('UPDATE code_context SET is_active = 0, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  private rowToCtx(row: Record<string, unknown>): CodeContext {
    return {
      id: row.id as string,
      project_name: row.project_name as string,
      project_path: row.project_path as string,
      tech_stack: row.tech_stack as string,
      architecture_notes: row.architecture_notes as string,
      recent_changes: row.recent_changes as string,
      decisions: row.decisions as string,
      is_active: row.is_active as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
