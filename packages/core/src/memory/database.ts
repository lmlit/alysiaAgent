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
      processed   INTEGER DEFAULT 0,
      archived    INTEGER DEFAULT 0   -- ★ 8-15 会话归档(软删除):归档会话从列表消失,数据保留
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

    -- ★ 8-27 配角在场状态（life-system-narrative-refactor，HDSI ScenePresence 简化版）
    --   present=在场 | off-scene=离场 | expected=待会合；事件内容提到谁 → present，
    --   24h 无提及 → off-scene。仅记录已确认在场的配角（角色世界书里的人物）。
    CREATE TABLE IF NOT EXISTS ai_life_scene_presence (
      name        TEXT PRIMARY KEY,       -- 配角名（如 迷迷/风堇/遐蝶/白厄）
      status      TEXT NOT NULL DEFAULT 'off-scene',  -- present | off-scene | expected
      basis       TEXT,                   -- 在场依据（最近一次提到的事件内容摘要）
      updated_at  TEXT NOT NULL
    );

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

  // ★ 8-15 会话归档：events 加 archived 列（软删除标记,旧库迁移）
  const evCols = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
  const evColNames = new Set(evCols.map(c => c.name));
  if (!evColNames.has('archived')) {
    db.exec(`ALTER TABLE events ADD COLUMN archived INTEGER DEFAULT 0`);
  }

  // ★ 8-27 叙事化重构（life-system-narrative-refactor）迁移——全部 ALTER + try-catch，不 DROP
  // 1) ai_life_state.mood_value：情绪累积值 -100..100（同向加成/反向衰减/8h 回归 0）
  try {
    db.exec(`ALTER TABLE ai_life_state ADD COLUMN mood_value INTEGER DEFAULT 0`);
  } catch { /* column already exists */ }
  // 2) ai_life_events.origin：'regular'(常规) | 'followup'(对话余波，不推送只记录)
  try {
    db.exec(`ALTER TABLE ai_life_events ADD COLUMN origin TEXT DEFAULT 'regular'`);
  } catch { /* column already exists */ }
  // 3) life_templates.category（独处/互动/分享）+ group_name（角色关系分组，回落按在场匹配）
  const ltCols = db.prepare(`PRAGMA table_info(life_templates)`).all() as Array<{ name: string }>;
  const ltColNames = new Set(ltCols.map(c => c.name));
  if (!ltColNames.has('category')) {
    db.exec(`ALTER TABLE life_templates ADD COLUMN category TEXT DEFAULT '独处'`);
  }
  if (!ltColNames.has('group_name')) {
    db.exec(`ALTER TABLE life_templates ADD COLUMN group_name TEXT DEFAULT 'none'`);
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
  //   INSERT OR IGNORE 以 id 幂等——用户可能已删过某条种子，重启不复活
  // ★ 8-27 扩容 43 条（life-system-narrative-refactor）：独处 20 / 互动 12 / 分享 11，
  //   按 category（独处/互动/分享）+ group_name（none/迷迷/风堇/遐蝶/白厄/其他人）分类——
  //   回落时优先选"在场角色组"模板；模板仍是保底，LLM 生成为主路径
  //   格式: [id, activity, type, weight, category, group_name]
  const seedTemplates: Array<[string, string, string, number, string, string]> = [
    // ── 独处（internal，无角色）──
    ['lt-seed-01', '给自己倒了杯水', 'internal', 5, '独处', 'none'],
    ['lt-seed-02', '翻着手机发呆，什么也没看进去', 'internal', 4, '独处', 'none'],
    ['lt-seed-03', '整理了一下房间，把书摆整齐了', 'internal', 3, '独处', 'none'],
    ['lt-seed-06', '泡了杯茶，坐在窗边慢慢喝', 'internal', 4, '独处', 'none'],
    ['lt-ref-09', '把阳台的绿植挨个擦了一遍叶子', 'internal', 3, '独处', 'none'],
    ['lt-ref-10', '窝在沙发里裹紧毯子，听窗外雨声一点点密起来', 'internal', 3, '独处', 'none'],
    ['lt-ref-11', '翻以前的小本子，看到几页写歪的字，笑了', 'internal', 2, '独处', 'none'],
    ['lt-ref-12', '煮了一锅热汤，盛一碗慢慢吹着喝', 'internal', 3, '独处', 'none'],
    ['lt-ref-13', '窗帘拉开一条缝，阳光正好落在脚边', 'internal', 2, '独处', 'none'],
    ['lt-ref-14', '蹲在门口逗了会儿路过的猫', 'internal', 2, '独处', 'none'],
    ['lt-ref-15', '收拾书架，把最上面那层重新码了一遍', 'internal', 2, '独处', 'none'],
    ['lt-ref-16', '泡了杯花茶，闻着香气发了一会儿呆', 'internal', 3, '独处', 'none'],
    ['lt-ref-17', '靠在窗边看楼下的行人撑着伞走过', 'internal', 2, '独处', 'none'],
    ['lt-ref-18', '睡前把明天的衣服叠好放在椅子上', 'internal', 2, '独处', 'none'],
    ['lt-ref-19', '站在厨房窗边吃苹果，看天一点点暗下来', 'internal', 2, '独处', 'none'],
    ['lt-ref-20', '把旧信纸翻出来，写了两行又收起来', 'internal', 2, '独处', 'none'],
    ['lt-ref-24', '把窗台的灰擦了擦，摆了一朵不知哪来的野花', 'internal', 2, '独处', 'none'],
    ['lt-ref-25', '煮水的时候盯着壶嘴冒的白汽发愣', 'internal', 2, '独处', 'none'],
    ['lt-ref-26', '找出针线，把袖口开线的地方缝好了', 'internal', 2, '独处', 'none'],
    ['lt-ref-27', '站在门口犹豫了一下，又转身回屋里躺下', 'internal', 2, '独处', 'none'],
    // ── 互动（internal，与在场配角的小交集）──
    ['lt-ref-30', '迷迷在我腿边团成一团，蹭了蹭我的手指', 'internal', 3, '互动', '迷迷'],
    ['lt-ref-31', '迷迷叼着我的发绳跑来跑去，像在邀我陪它玩', 'internal', 3, '互动', '迷迷'],
    ['lt-ref-32', '迷迷趴在我肩上睡着了，我都不敢动', 'internal', 3, '互动', '迷迷'],
    ['lt-ref-38', '迷迷在窗台上晒太阳，我把脸贴过去蹭了蹭它', 'internal', 3, '互动', '迷迷'],
    ['lt-ref-33', '风堇路过时递给我一束药草，说闻着安神', 'internal', 3, '互动', '风堇'],
    ['lt-ref-34', '在昏光庭院门口碰见风堇，她笑着说今天风很好', 'internal', 3, '互动', '风堇'],
    ['lt-ref-39', '和风堇一起摘了院子里的花，她说拿去做干花', 'internal', 2, '互动', '风堇'],
    ['lt-ref-35', '遐蝶安静地坐在旁边看书，我们谁也没说话，却很舒服', 'internal', 3, '互动', '遐蝶'],
    ['lt-ref-41', '遐蝶给我带了一块糖，说是路上买的，很甜', 'internal', 3, '互动', '遐蝶'],
    ['lt-ref-36', '白厄在院子里劈柴，我坐在台阶上看他，偶尔搭两句话', 'internal', 3, '互动', '白厄'],
    ['lt-ref-40', '白厄难得清闲，在院子里给花浇水，我帮他递水壶', 'internal', 2, '互动', '白厄'],
    ['lt-ref-37', '那刻夏路过时又考了我一个问题，我答上来了他难得点了点头', 'internal', 2, '互动', '其他人'],
    // ── 分享（chat，对轻月说的话）──
    ['lt-seed-04', '听到楼下琴声，有点想学', 'chat', 2, '分享', 'none'],
    ['lt-seed-05', '看到窗外的云朵像一只兔子', 'chat', 2, '分享', 'none'],
    ['lt-seed-07', '翻到一张旧照片，想起一些往事', 'chat', 2, '分享', 'none'],
    ['lt-seed-08', '在阳台看了会儿星星', 'chat', 3, '分享', 'none'],
    ['lt-ref-21', '今天路过花店，看到一束很像你喜欢的颜色的花', 'chat', 2, '分享', 'none'],
    ['lt-ref-22', '试了新学的点心，味道居然还不错，想让你也尝尝', 'chat', 2, '分享', 'none'],
    ['lt-ref-23', '窗外的月亮很圆，突然想到你', 'chat', 2, '分享', 'none'],
    ['lt-ref-42', '我数了数，今天遇到的好事有七八件，想挑一件讲给你听', 'chat', 2, '分享', 'none'],
    ['lt-ref-43', '学着做了一道你提过的菜，结果做得还行，下次想做给你吃', 'chat', 2, '分享', 'none'],
    ['lt-ref-44', '看到夕阳把云染成橘红色，心里突然软了一下', 'chat', 2, '分享', 'none'],
    ['lt-ref-45', '今天试着画了一幅窗外的风景，画得不太像，但自己很喜欢', 'chat', 2, '分享', 'none'],
  ];
  const seedInsert = db.prepare(`
    INSERT OR IGNORE INTO life_templates (id, activity, type, weight, source, created_at, category, group_name)
    VALUES (?, ?, ?, ?, 'seed', ?, ?, ?)
  `);
  for (const [id, activity, type, weight, category, groupName] of seedTemplates) {
    seedInsert.run(id, activity, type, weight, now, category, groupName);
  }
  // 旧库升级：已存在的 seed 行补分类（INSERT OR IGNORE 跳过后分类仍是默认值）
  const seedClassify = db.prepare(`
    UPDATE life_templates SET category = ?, group_name = ? WHERE id = ? AND source = 'seed'
  `);
  for (const [id, , , , category, groupName] of seedTemplates) {
    seedClassify.run(category, groupName, id);
  }
}
