// src/memory/database.ts
import type Database from 'better-sqlite3';

export function initializeDatabase(db: Database.Database): void {
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      source      TEXT NOT NULL,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      importance  REAL DEFAULT 0.0,
      created_at  TEXT NOT NULL,
      processed   INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(processed, created_at);

    CREATE TABLE IF NOT EXISTS user_profile (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      basics      TEXT NOT NULL DEFAULT '{}',
      preferences TEXT NOT NULL DEFAULT '{}',
      facts       TEXT NOT NULL DEFAULT '[]',
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS persona (
      id              INTEGER PRIMARY KEY DEFAULT 1,
      name            TEXT NOT NULL DEFAULT '昔涟',
      tone            TEXT NOT NULL DEFAULT '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}',
      speech_style    TEXT NOT NULL DEFAULT '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}',
      emotional_range TEXT NOT NULL DEFAULT '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}',
      adaptation_hints TEXT NOT NULL DEFAULT '[]',
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      summary         TEXT NOT NULL,
      participants    TEXT NOT NULL DEFAULT '[]',
      topics          TEXT NOT NULL DEFAULT '[]',
      key_decisions   TEXT NOT NULL DEFAULT '[]',
      message_count   INTEGER DEFAULT 0,
      started_at      TEXT NOT NULL,
      ended_at        TEXT,
      embedding_id    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_conv_time ON conversations(started_at);

    CREATE TABLE IF NOT EXISTS knowledge_docs (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      source          TEXT NOT NULL,
      file_path       TEXT,
      content_hash    TEXT NOT NULL,
      chunk_count     INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'active',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worldbook_entries (
      id              TEXT PRIMARY KEY,
      trigger_keys    TEXT NOT NULL,
      trigger_mode    TEXT DEFAULT 'any',
      content         TEXT NOT NULL,
      scope           TEXT DEFAULT 'chat',
      priority        INTEGER DEFAULT 0,
      cooldown_sec    INTEGER DEFAULT 300,
      last_triggered  TEXT,
      hit_count       INTEGER DEFAULT 0,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wb_keys ON worldbook_entries(trigger_keys);

    CREATE TABLE IF NOT EXISTS code_context (
      id              TEXT PRIMARY KEY,
      project_name    TEXT NOT NULL,
      project_path    TEXT NOT NULL,
      tech_stack      TEXT NOT NULL DEFAULT '{}',
      architecture_notes TEXT DEFAULT '',
      recent_changes  TEXT DEFAULT '[]',
      decisions       TEXT DEFAULT '[]',
      is_active       INTEGER DEFAULT 1,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
  `);
}
