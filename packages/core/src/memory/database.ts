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
      memory_config   TEXT NOT NULL DEFAULT '{"retention_bias":0.2,"decay_rate":0.3,"importance_threshold":0.4,"recency_weight":0.3,"confirmation_bias":0.3}',
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

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id          TEXT PRIMARY KEY,
      doc_id      TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON knowledge_chunks(doc_id);

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

    CREATE TABLE IF NOT EXISTS ai_life_state (
      id              INTEGER PRIMARY KEY DEFAULT 1,
      current_activity TEXT,
      mood            TEXT,
      intimacy        INTEGER DEFAULT 30,
      last_event_id   TEXT,
      updated_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_life_events (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL,
      type            TEXT NOT NULL,
      content         TEXT NOT NULL,
      mood_delta      TEXT,
      reference_event_id TEXT,
      wb_entry_id     TEXT,
      delivered       INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_life_events_time ON ai_life_events(created_at);

    -- ★ 8-12 提醒持久化（reminder-sqlite-persistence）：容器重启不丢失
    CREATE TABLE IF NOT EXISTS reminders (
      id          TEXT PRIMARY KEY,
      text        TEXT NOT NULL,
      trigger_at  INTEGER NOT NULL,   -- epoch ms
      session_id  TEXT NOT NULL DEFAULT '',
      retry_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ai_life_daily_summaries (
      date            TEXT PRIMARY KEY,
      summary         TEXT NOT NULL,
      created_at      TEXT
    );

    -- ★ 8-14 生活模板池（content-self-evolution）：替代 server/life-templates.ts const
    --   source='seed'(既有种子) | 'self'(昔涟自写)；自写条目 weight 固定 2（防权重操纵）
    CREATE TABLE IF NOT EXISTS life_templates (
      id          TEXT PRIMARY KEY,
      activity    TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'internal',  -- 'chat' | 'internal'
      weight      INTEGER NOT NULL DEFAULT 2,
      source      TEXT NOT NULL DEFAULT 'seed',
      created_at  TEXT NOT NULL
    );
  `);

  // Migration: add memory_config to existing persona table (v2)
  try {
    db.exec(`ALTER TABLE persona ADD COLUMN memory_config TEXT NOT NULL DEFAULT '{"retention_bias":0.2,"decay_rate":0.3,"importance_threshold":0.4,"recency_weight":0.3,"confirmation_bias":0.3}'`);
  } catch { /* column already exists */ }

  // Migration: 角色系统 (v3) — persona 多行化 + worldbook role 维度
  const personaCols = db.prepare(`PRAGMA table_info(persona)`).all() as Array<{ name: string }>;
  const personaColNames = new Set(personaCols.map(c => c.name));
  if (!personaColNames.has('role')) {
    db.exec(`ALTER TABLE persona ADD COLUMN role TEXT DEFAULT 'alysia'`);
  }
  if (!personaColNames.has('system_prompt')) {
    db.exec(`ALTER TABLE persona ADD COLUMN system_prompt TEXT DEFAULT ''`);
  }
  if (!personaColNames.has('is_active')) {
    db.exec(`ALTER TABLE persona ADD COLUMN is_active INTEGER DEFAULT 0`);
  }
  // 现有 id=1 行升级为激活的内置角色
  db.prepare(`UPDATE persona SET role = 'alysia', is_active = 1 WHERE id = 1 AND (role IS NULL OR role = 'alysia')`).run();

  const wbCols = db.prepare(`PRAGMA table_info(worldbook_entries)`).all() as Array<{ name: string }>;
  const wbColNames = new Set(wbCols.map(c => c.name));
  if (!wbColNames.has('role')) {
    db.exec(`ALTER TABLE worldbook_entries ADD COLUMN role TEXT DEFAULT 'alysia'`);
  }
  if (!wbColNames.has('content_type')) {
    db.exec(`ALTER TABLE worldbook_entries ADD COLUMN content_type TEXT DEFAULT 'text'`);
  }
  // ★ 8-14 内容自进化：条目来源标记（seed=角色包导入/seed，self=昔涟自写）
  if (!wbColNames.has('source')) {
    db.exec(`ALTER TABLE worldbook_entries ADD COLUMN source TEXT DEFAULT 'seed'`);
  }

  // Seed default singleton rows
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
    VALUES (1, '{}', '{}', '[]', ?)
  `).run(now);

  db.prepare(`
    INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, memory_config, adaptation_hints, updated_at, role, is_active)
    VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}', '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}', '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '{"retention_bias":0.2,"decay_rate":0.3,"importance_threshold":0.4,"recency_weight":0.3,"confirmation_bias":0.3}', '[]', ?, 'alysia', 1)
  `).run(now);

  // ★ 8-14 生活模板池种子（content-self-evolution）：8 条既有模板（原 server/life-templates.ts const）
  //   INSERT OR IGNORE 以 activity 幂等——用户可能已删过某条种子，重启不复活
  const seedTemplates: Array<[string, string, string, number]> = [
    ['lt-seed-01', '给自己倒了杯水', 'internal', 5],
    ['lt-seed-02', '翻着手机发呆，什么也没看进去', 'internal', 4],
    ['lt-seed-03', '整理了一下房间，把书摆整齐了', 'internal', 3],
    ['lt-seed-04', '听到楼下琴声，有点想学', 'chat', 2],
    ['lt-seed-05', '看到窗外的云朵像一只兔子', 'chat', 2],
    ['lt-seed-06', '泡了杯茶，坐在窗边慢慢喝', 'internal', 4],
    ['lt-seed-07', '翻到一张旧照片，想起一些往事', 'chat', 2],
    ['lt-seed-08', '在阳台看了会儿星星', 'chat', 3],
  ];
  const seedInsert = db.prepare(`
    INSERT OR IGNORE INTO life_templates (id, activity, type, weight, source, created_at)
    VALUES (?, ?, ?, ?, 'seed', ?)
  `);
  for (const [id, activity, type, weight] of seedTemplates) {
    seedInsert.run(id, activity, type, weight, now);
  }
}
