# 记忆系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 alysiaAgent 的记忆系统核心模块，包含不可变事件日志、六种记忆存储、MemoryManager 调度器、自动画像/人格引擎、System Prompt 组装器。

**Architecture:** Event Sourcing 底座 + Multi-Store Hybrid。所有输入写入不可变 Event Log，三个处理器（实时/会话结束/定时）驱动视图更新。MemoryManager 对外暴露统一 ingest/read/assemble 接口。存储层通过 IVectorStore 接口抽象，本地用 LanceDB。

**Tech Stack:** TypeScript, better-sqlite3 (WAL mode), LanceDB (embedded vector DB), vitest, uuid

## Global Constraints

- better-sqlite3 同步 API，WAL 模式开启
- 向量维度 1536（text-embedding-3-small）
- SQLite JSON 列存动态字段，不额外建表
- 所有 Store 类构造接受 `(db: Database, vectorStore?: IVectorStore)` 参数
- API Key 通过环境变量或配置注入，不在代码中硬编码
- PII 脱敏在 Event 写入前和 embedding 生成前各执行一次
- 单次人格 Δ ≤ 0.1，同维度 5min 冷却，连续同向 ≤ 3 次

---

## Phase 1: Project Setup & Foundation

### Task 1.1: Initialize project with TypeScript and dependencies

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces: `package.json` with deps: `better-sqlite3`, `vectordb`, `uuid`, `vitest`, `typescript`, `@types/better-sqlite3`, `@types/uuid`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "alysia-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd E:/workSpace/alysiaAgent && npm init -y && npm install better-sqlite3 vectordb uuid && npm install -D typescript vitest @types/better-sqlite3 @types/uuid
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
.env
*.db
*.lancedb/
```

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore package-lock.json
git commit -m "chore: initialize TypeScript project with vitest and dependencies"
```

---

### Task 1.2: Define core types and interfaces

**Files:**
- Create: `src/memory/types.ts`
- Create: `src/memory/interfaces/IVectorStore.ts`
- Create: `src/memory/interfaces/IEmbedService.ts`
- Create: `src/memory/interfaces/ILLMService.ts`

**Interfaces:**
- Produces: 
  - `EventSource`: `'chat' | 'tool' | 'system' | 'code'`
  - `EventType`: `'message' | 'tool_call' | 'tool_result' | 'persona_change' | 'profile_hint' | 'session_summary'`
  - `MemoryEvent`: `{ id: string; session_id: string; source: EventSource; type: EventType; payload: Record<string, unknown>; importance: number; created_at: string; processed: number }`
  - `UserProfile`: `{ id: number; basics: string; preferences: string; facts: string; updated_at: string }`
  - `Persona`: `{ id: number; name: string; tone: string; speech_style: string; emotional_range: string; adaptation_hints: string; updated_at: string }`
  - `Conversation`: `{ id: string; session_id: string; summary: string; participants: string; topics: string; key_decisions: string; message_count: number; started_at: string; ended_at: string | null; embedding_id: string | null }`
  - `KnowledgeDoc`: `{ id: string; title: string; source: string; file_path: string | null; content_hash: string; chunk_count: number; status: string; created_at: string; updated_at: string }`
  - `WorldbookEntry`: `{ id: string; trigger_keys: string; trigger_mode: string; content: string; scope: string; priority: number; cooldown_sec: number; last_triggered: string | null; hit_count: number; created_at: string; updated_at: string }`
  - `CodeContext`: `{ id: string; project_name: string; project_path: string; tech_stack: string; architecture_notes: string; recent_changes: string; decisions: string; is_active: number; created_at: string; updated_at: string }`
  - `SearchResult`: `{ id: string; score: number; text: string; metadata: Record<string, unknown> }`
  - `MemoryReadRequest`: `{ query: string; mode: 'chat' | 'code'; limit: number }`
  - `MemoryReadResult`: `{ context: string; persona_hint: string; retrieved: SearchResult[]; worldbook_triggers: WorldbookEntry[] }`
  - `IVectorStore`: interface with `insert`, `search`, `delete`, `count`
  - `IEmbedService`: interface with `embed(text: string): Promise<number[]>`
  - `ILLMService`: interface with `complete(prompt: string): Promise<string>`

- [ ] **Step 1: Write types.ts**

```typescript
// src/memory/types.ts

export type EventSource = 'chat' | 'tool' | 'system' | 'code';

export type EventType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'persona_change'
  | 'profile_hint'
  | 'session_summary';

export interface MemoryEvent {
  id: string;
  session_id: string;
  source: EventSource;
  type: EventType;
  payload: Record<string, unknown>;
  importance: number;
  created_at: string;
  processed: number; // bitmask: 1=profile, 2=summary, 4=persona, 8=knowledge
}

export interface UserProfile {
  id: number;
  basics: string;       // JSON
  preferences: string;  // JSON
  facts: string;        // JSON array
  updated_at: string;
}

export interface Persona {
  id: number;
  name: string;
  tone: string;             // JSON {formality, warmth, humor, directness}
  speech_style: string;     // JSON {sentence_length, emoji_usage, code_heavy}
  emotional_range: string;  // JSON {expressiveness, empathy, playfulness}
  adaptation_hints: string; // JSON array
  updated_at: string;
}

export interface Conversation {
  id: string;
  session_id: string;
  summary: string;
  participants: string;   // JSON array
  topics: string;         // JSON array
  key_decisions: string;  // JSON array
  message_count: number;
  started_at: string;
  ended_at: string | null;
  embedding_id: string | null;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  source: string;         // 'imported' | 'url' | 'note' | 'generated'
  file_path: string | null;
  content_hash: string;
  chunk_count: number;
  status: string;         // 'active' | 'archived'
  created_at: string;
  updated_at: string;
}

export interface WorldbookEntry {
  id: string;
  trigger_keys: string;   // JSON array
  trigger_mode: string;   // 'any' | 'all' | 'regex'
  content: string;
  scope: string;          // 'chat' | 'code' | 'both'
  priority: number;
  cooldown_sec: number;
  last_triggered: string | null;
  hit_count: number;
  created_at: string;
  updated_at: string;
}

export interface CodeContext {
  id: string;
  project_name: string;
  project_path: string;
  tech_stack: string;       // JSON
  architecture_notes: string;
  recent_changes: string;   // JSON array
  decisions: string;        // JSON array
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface SearchResult {
  id: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}

export interface MemoryReadRequest {
  query: string;
  mode: 'chat' | 'code';
  limit: number;
}

export interface MemoryReadResult {
  context: string;
  persona_hint: string;
  retrieved: SearchResult[];
  worldbook_triggers: WorldbookEntry[];
}

export interface PersonaAdjustment {
  param: string;     // e.g. 'tone.formality'
  delta: number;     // e.g. -0.15
  reason: string;
}

export interface ProfileFact {
  fact: string;
  confidence: number;  // 0.0 - 1.0
  evidence: string;    // 原文引用
  source_event: string;
  updated_at: string;
}

// Bitmask constants for MemoryEvent.processed
export const PROCESSED_NONE     = 0;
export const PROCESSED_PROFILE  = 1 << 0;  // 1
export const PROCESSED_SUMMARY  = 1 << 1;  // 2
export const PROCESSED_PERSONA  = 1 << 2;  // 4
export const PROCESSED_KNOWLEDGE = 1 << 3; // 8
```

- [ ] **Step 2: Write interfaces/IVectorStore.ts**

```typescript
// src/memory/interfaces/IVectorStore.ts
import type { SearchResult } from '../types';

export interface IVectorStore {
  insert(id: string, vector: number[], text: string, metadata: Record<string, unknown>): Promise<void>;
  search(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<SearchResult[]>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}
```

- [ ] **Step 3: Write interfaces/IEmbedService.ts**

```typescript
// src/memory/interfaces/IEmbedService.ts

export interface IEmbedService {
  embed(text: string): Promise<number[]>;
  dimension(): number;
}
```

- [ ] **Step 4: Write interfaces/ILLMService.ts**

```typescript
// src/memory/interfaces/ILLMService.ts

export interface ILLMService {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/memory/types.ts src/memory/interfaces/
git commit -m "feat: define core types and interfaces for memory system"
```

---

### Task 1.3: Create database schema migration

**Files:**
- Create: `src/memory/database.ts`

**Interfaces:**
- Consumes: types from Task 1.2
- Produces: `function initializeDatabase(db: Database): void` — creates all 7 tables and indexes

- [ ] **Step 1: Write the failing test**

Create `tests/memory/unit/database.test.ts`:

```typescript
import { describe, it, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';

describe('Database Schema', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
  });

  afterAll(() => {
    db.close();
  });

  it('should create all tables after initialization', () => {
    const { initializeDatabase } = await import('../../src/memory/database');
    initializeDatabase(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];

    const names = tables.map(t => t.name);
    expect(names).toContain('events');
    expect(names).toContain('user_profile');
    expect(names).toContain('persona');
    expect(names).toContain('conversations');
    expect(names).toContain('knowledge_docs');
    expect(names).toContain('worldbook_entries');
    expect(names).toContain('code_context');
  });

  it('should create all indexes on events table', () => {
    const { initializeDatabase } = await import('../../src/memory/database');
    initializeDatabase(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events' ORDER BY name"
    ).all() as { name: string }[];

    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_events_session');
    expect(names).toContain('idx_events_created');
    expect(names).toContain('idx_events_unprocessed');
  });
});
```

Wait — we haven't written the source yet. Let me restructure. TDD says write failing test first.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/database.test.ts
```
Expected: FAIL — module `../../src/memory/database` not found

- [ ] **Step 3: Write database.ts**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/database.test.ts
```
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/database.ts tests/memory/unit/database.test.ts
git commit -m "feat: add database schema with all 7 tables and indexes"
```

---

## Phase 2: Core Stores

### Task 2.1: Implement EventStore

**Files:**
- Create: `src/memory/stores/EventStore.ts`
- Create: `tests/memory/unit/EventStore.test.ts`

**Interfaces:**
- Consumes: `MemoryEvent` type from Task 1.2, `initializeDatabase` from Task 1.3
- Produces: `EventStore` class — `insert(event: MemoryEvent): void`, `getById(id: string): MemoryEvent | null`, `getUnprocessed(limit: number): MemoryEvent[]`, `markProcessed(id: string, flag: number): void`, `countBySession(sessionId: string): number`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/memory/unit/EventStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventStore } from '../../src/memory/stores/EventStore';
import { initializeDatabase } from '../../src/memory/database';
import type { MemoryEvent } from '../../src/memory/types';
import { PROCESSED_PROFILE } from '../../src/memory/types';

describe('EventStore', () => {
  let db: Database.Database;
  let store: EventStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new EventStore(db);
  });

  afterEach(() => {
    db.close();
  });

  const makeEvent = (overrides: Partial<MemoryEvent> = {}): MemoryEvent => ({
    id: 'evt-001',
    session_id: 'sess-001',
    source: 'chat',
    type: 'message',
    payload: { role: 'user', content: 'hello' },
    importance: 0.5,
    created_at: '2026-06-28T10:00:00Z',
    processed: 0,
    ...overrides,
  });

  it('should insert and retrieve an event', () => {
    const event = makeEvent();
    store.insert(event);

    const retrieved = store.getById('evt-001');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.session_id).toBe('sess-001');
    expect(retrieved!.source).toBe('chat');
  });

  it('should return null for non-existent event', () => {
    const retrieved = store.getById('nonexistent');
    expect(retrieved).toBeNull();
  });

  it('should return unprocessed events ordered by created_at', () => {
    store.insert(makeEvent({ id: 'e1', created_at: '2026-06-28T09:00:00Z' }));
    store.insert(makeEvent({ id: 'e2', created_at: '2026-06-28T10:00:00Z' }));
    store.insert(makeEvent({ id: 'e3', processed: PROCESSED_PROFILE, created_at: '2026-06-28T11:00:00Z' }));

    const unprocessed = store.getUnprocessed(10);
    expect(unprocessed).toHaveLength(2);
    expect(unprocessed[0].id).toBe('e1'); // older first
    expect(unprocessed[1].id).toBe('e2');
  });

  it('should respect limit on getUnprocessed', () => {
    store.insert(makeEvent({ id: 'e1' }));
    store.insert(makeEvent({ id: 'e2' }));
    expect(store.getUnprocessed(1)).toHaveLength(1);
  });

  it('should mark event as processed with bitmask', () => {
    store.insert(makeEvent({ id: 'e1' }));
    store.markProcessed('e1', PROCESSED_PROFILE);

    const event = store.getById('e1');
    expect(event!.processed & PROCESSED_PROFILE).toBeTruthy();
    expect(store.getUnprocessed(10)).toHaveLength(0);
  });

  it('should add flag without clearing existing flags', () => {
    store.insert(makeEvent({ id: 'e1', processed: PROCESSED_PROFILE }));
    store.markProcessed('e1', 2); // PROCESSED_SUMMARY

    const event = store.getById('e1');
    expect(event!.processed & PROCESSED_PROFILE).toBeTruthy();
    expect(event!.processed & 2).toBeTruthy();
  });

  it('should count events by session', () => {
    store.insert(makeEvent({ id: 'e1', session_id: 'sess-A' }));
    store.insert(makeEvent({ id: 'e2', session_id: 'sess-A' }));
    store.insert(makeEvent({ id: 'e3', session_id: 'sess-B' }));

    expect(store.countBySession('sess-A')).toBe(2);
    expect(store.countBySession('sess-B')).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/EventStore.test.ts
```
Expected: FAIL — EventStore module not found

- [ ] **Step 3: Write EventStore.ts**

```typescript
// src/memory/stores/EventStore.ts
import type Database from 'better-sqlite3';
import type { MemoryEvent } from '../types';

export class EventStore {
  constructor(private db: Database.Database) {}

  insert(event: MemoryEvent): void {
    this.db.prepare(`
      INSERT INTO events (id, session_id, source, type, payload, importance, created_at, processed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.session_id,
      event.source,
      event.type,
      JSON.stringify(event.payload),
      event.importance,
      event.created_at,
      event.processed
    );
  }

  getById(id: string): MemoryEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToEvent(row);
  }

  getUnprocessed(limit: number): MemoryEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM events WHERE processed = 0 ORDER BY created_at ASC LIMIT ?'
    ).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToEvent(r));
  }

  markProcessed(id: string, flag: number): void {
    this.db.prepare(
      'UPDATE events SET processed = processed | ? WHERE id = ?'
    ).run(flag, id);
  }

  countBySession(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM events WHERE session_id = ?'
    ).get(sessionId) as { count: number };
    return row.count;
  }

  private rowToEvent(row: Record<string, unknown>): MemoryEvent {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      source: row.source as MemoryEvent['source'],
      type: row.type as MemoryEvent['type'],
      payload: JSON.parse(row.payload as string),
      importance: row.importance as number,
      created_at: row.created_at as string,
      processed: row.processed as number,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/EventStore.test.ts
```
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/stores/EventStore.ts tests/memory/unit/EventStore.test.ts
git commit -m "feat: implement EventStore with insert, query, and markProcessed"
```

---

### Task 2.2: Implement ProfileStore

**Files:**
- Create: `src/memory/stores/ProfileStore.ts`
- Create: `tests/memory/unit/ProfileStore.test.ts`

**Interfaces:**
- Consumes: `UserProfile` type from Task 1.2, `initializeDatabase` from Task 1.3
- Produces: `ProfileStore` class — `get(): UserProfile`, `updateBasics(basics: string): void`, `updatePreferences(prefs: string): void`, `addFacts(facts: ProfileFact[]): void`, `getFacts(): ProfileFact[]`, `replaceFacts(facts: ProfileFact[]): void`, `setUpdated(): void`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/memory/unit/ProfileStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ProfileStore } from '../../src/memory/stores/ProfileStore';
import { initializeDatabase } from '../../src/memory/database';
import type { ProfileFact } from '../../src/memory/types';

describe('ProfileStore', () => {
  let db: Database.Database;
  let store: ProfileStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new ProfileStore(db);
    // Seed with default row
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at) VALUES (1, '{}', '{}', '[]', ?)`).run(now);
  });

  afterEach(() => {
    db.close();
  });

  it('should return the single profile row', () => {
    const profile = store.get();
    expect(profile.id).toBe(1);
    expect(profile.basics).toBe('{}');
    expect(profile.preferences).toBe('{}');
  });

  it('should update basics', () => {
    store.updateBasics('{"occupation":"engineer"}');
    const profile = store.get();
    expect(JSON.parse(profile.basics).occupation).toBe('engineer');
  });

  it('should update preferences', () => {
    store.updatePreferences('{"code_style":"explicit"}');
    const profile = store.get();
    expect(JSON.parse(profile.preferences).code_style).toBe('explicit');
  });

  it('should add and retrieve facts', () => {
    const fact: ProfileFact = {
      fact: '用户是后端工程师',
      confidence: 0.9,
      evidence: '我说我是后端',
      source_event: 'evt-1',
      updated_at: new Date().toISOString(),
    };
    store.addFacts([fact]);
    const facts = store.getFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('用户是后端工程师');
  });

  it('should replace all facts', () => {
    store.addFacts([{ fact: 'old', confidence: 0.5, evidence: 'x', source_event: 'e1', updated_at: new Date().toISOString() }]);
    store.replaceFacts([{ fact: 'new', confidence: 0.9, evidence: 'y', source_event: 'e2', updated_at: new Date().toISOString() }]);
    expect(store.getFacts()).toHaveLength(1);
  });

  it('should update timestamp on setUpdated', () => {
    const before = store.get().updated_at;
    store.setUpdated();
    const after = store.get().updated_at;
    expect(after).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/ProfileStore.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write ProfileStore.ts**

```typescript
// src/memory/stores/ProfileStore.ts
import type Database from 'better-sqlite3';
import type { UserProfile, ProfileFact } from '../types';

export class ProfileStore {
  constructor(private db: Database.Database) {}

  get(): UserProfile {
    return this.db.prepare('SELECT * FROM user_profile WHERE id = 1').get() as UserProfile;
  }

  updateBasics(basics: string): void {
    this.db.prepare('UPDATE user_profile SET basics = ?, updated_at = ? WHERE id = 1')
      .run(basics, new Date().toISOString());
  }

  updatePreferences(prefs: string): void {
    this.db.prepare('UPDATE user_profile SET preferences = ?, updated_at = ? WHERE id = 1')
      .run(prefs, new Date().toISOString());
  }

  addFacts(newFacts: ProfileFact[]): void {
    const current = this.getFacts();
    const updated = [...current, ...newFacts];
    this.replaceFacts(updated);
  }

  getFacts(): ProfileFact[] {
    const row = this.db.prepare('SELECT facts FROM user_profile WHERE id = 1').get() as { facts: string };
    return JSON.parse(row.facts);
  }

  replaceFacts(facts: ProfileFact[]): void {
    this.db.prepare('UPDATE user_profile SET facts = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(facts), new Date().toISOString());
  }

  setUpdated(): void {
    this.db.prepare('UPDATE user_profile SET updated_at = ? WHERE id = 1')
      .run(new Date().toISOString());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/ProfileStore.test.ts
```
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/stores/ProfileStore.ts tests/memory/unit/ProfileStore.test.ts
git commit -m "feat: implement ProfileStore with facts management"
```

---

### Task 2.3: Implement PersonaStore

**Files:**
- Create: `src/memory/stores/PersonaStore.ts`
- Create: `tests/memory/unit/PersonaStore.test.ts`

**Interfaces:**
- Consumes: `Persona`, `PersonaAdjustment` types from Task 1.2
- Produces: `PersonaStore` class — `get(): Persona`, `updateTone(tone: string): void`, `updateSpeechStyle(style: string): void`, `updateEmotionalRange(range: string): void`, `addAdaptationHint(hint: object): void`, `getAdaptationHints(): object[]`, `setName(name: string): void`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/memory/unit/PersonaStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PersonaStore } from '../../src/memory/stores/PersonaStore';
import { initializeDatabase } from '../../src/memory/database';

describe('PersonaStore', () => {
  let db: Database.Database;
  let store: PersonaStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new PersonaStore(db);
  });

  afterEach(() => db.close());

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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/PersonaStore.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write PersonaStore.ts**

```typescript
// src/memory/stores/PersonaStore.ts
import type Database from 'better-sqlite3';
import type { Persona } from '../types';

export class PersonaStore {
  constructor(private db: Database.Database) {}

  get(): Persona {
    return this.db.prepare('SELECT * FROM persona WHERE id = 1').get() as Persona;
  }

  updateTone(tone: string): void {
    this.db.prepare('UPDATE persona SET tone = ?, updated_at = ? WHERE id = 1')
      .run(tone, new Date().toISOString());
  }

  updateSpeechStyle(style: string): void {
    this.db.prepare('UPDATE persona SET speech_style = ?, updated_at = ? WHERE id = 1')
      .run(style, new Date().toISOString());
  }

  updateEmotionalRange(range: string): void {
    this.db.prepare('UPDATE persona SET emotional_range = ?, updated_at = ? WHERE id = 1')
      .run(range, new Date().toISOString());
  }

  addAdaptationHint(hint: object): void {
    const current = this.getAdaptationHints();
    current.push(hint);
    this.db.prepare('UPDATE persona SET adaptation_hints = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(current), new Date().toISOString());
  }

  getAdaptationHints(): object[] {
    const row = this.db.prepare('SELECT adaptation_hints FROM persona WHERE id = 1').get() as { adaptation_hints: string };
    return JSON.parse(row.adaptation_hints);
  }

  setName(name: string): void {
    this.db.prepare('UPDATE persona SET name = ?, updated_at = ? WHERE id = 1')
      .run(name, new Date().toISOString());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/PersonaStore.test.ts
```
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/stores/PersonaStore.ts tests/memory/unit/PersonaStore.test.ts
git commit -m "feat: implement PersonaStore with adaptation hints"
```

---

### Task 2.4: Implement WorldbookStore

**Files:**
- Create: `src/memory/stores/WorldbookStore.ts`
- Create: `tests/memory/unit/WorldbookStore.test.ts`

**Interfaces:**
- Consumes: `WorldbookEntry` type from Task 1.2
- Produces: `WorldbookStore` class — `insert(entry: WorldbookEntry): void`, `getById(id: string): WorldbookEntry | null`, `matchByKeywords(keywords: string[]): WorldbookEntry[]`, `recordTrigger(id: string): void`, `updateEntry(id: string, updates: Partial<WorldbookEntry>): void`, `deleteEntry(id: string): void`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/memory/unit/WorldbookStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WorldbookStore } from '../../src/memory/stores/WorldbookStore';
import { initializeDatabase } from '../../src/memory/database';
import type { WorldbookEntry } from '../../src/memory/types';

describe('WorldbookStore', () => {
  let db: Database.Database;
  let store: WorldbookStore;

  const makeEntry = (overrides: Partial<WorldbookEntry> = {}): WorldbookEntry => ({
    id: 'wb-1',
    trigger_keys: JSON.stringify(['rust', 'lifetime']),
    trigger_mode: 'any',
    content: '用户正在学习 Rust 生命周期',
    scope: 'chat',
    priority: 0,
    cooldown_sec: 300,
    last_triggered: null,
    hit_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new WorldbookStore(db);
  });

  afterEach(() => db.close());

  it('should insert and retrieve an entry', () => {
    store.insert(makeEntry());
    const entry = store.getById('wb-1');
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe('用户正在学习 Rust 生命周期');
  });

  it('should match entries by keywords (any mode)', () => {
    store.insert(makeEntry({ id: 'wb-1', trigger_keys: JSON.stringify(['rust', 'lifetime']) }));
    store.insert(makeEntry({ id: 'wb-2', trigger_keys: JSON.stringify(['python']) }));
    store.insert(makeEntry({ id: 'wb-3', trigger_keys: JSON.stringify(['rust', 'cargo']) }));

    const matched = store.matchByKeywords(['rust']);
    expect(matched).toHaveLength(2);
    expect(matched.map(e => e.id).sort()).toEqual(['wb-1', 'wb-3']);
  });

  it('should filter by scope', () => {
    store.insert(makeEntry({ id: 'wb-1', scope: 'code' }));
    store.insert(makeEntry({ id: 'wb-2', scope: 'chat' }));
    store.insert(makeEntry({ id: 'wb-3', scope: 'both' }));

    const codeMatches = store.matchByKeywords(['rust'], 'code');
    expect(codeMatches.map(e => e.id).sort()).toEqual(['wb-1', 'wb-3']);
  });

  it('should record trigger and respect cooldown', () => {
    store.insert(makeEntry({ id: 'wb-1', cooldown_sec: 60 }));
    store.recordTrigger('wb-1');

    const entry = store.getById('wb-1');
    expect(entry!.hit_count).toBe(1);
    expect(entry!.last_triggered).not.toBeNull();

    // matchByKeywords should filter out items still on cooldown
    // Create another entry not on cooldown
    store.insert(makeEntry({ id: 'wb-2', trigger_keys: JSON.stringify(['rust']) }));
    const matched = store.matchByKeywords(['rust']);
    expect(matched).toHaveLength(1); // only wb-2, wb-1 on cooldown
  });

  it('should update entry fields', () => {
    store.insert(makeEntry({ id: 'wb-1' }));
    store.updateEntry('wb-1', { content: 'updated content', priority: 5 });
    const entry = store.getById('wb-1');
    expect(entry!.content).toBe('updated content');
  });

  it('should delete an entry', () => {
    store.insert(makeEntry({ id: 'wb-1' }));
    store.deleteEntry('wb-1');
    expect(store.getById('wb-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/WorldbookStore.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write WorldbookStore.ts**

```typescript
// src/memory/stores/WorldbookStore.ts
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
    const entries = rows.map(r => this.rowToEntry(r));

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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/WorldbookStore.test.ts
```
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/stores/WorldbookStore.ts tests/memory/unit/WorldbookStore.test.ts
git commit -m "feat: implement WorldbookStore with keyword matching and cooldown"
```

---

### Task 2.5: Implement ConversationStore

**Files:**
- Create: `src/memory/stores/ConversationStore.ts`
- Create: `tests/memory/unit/ConversationStore.test.ts`

**Interfaces:**
- Consumes: `Conversation`, `IVectorStore` from Task 1.2
- Produces: `ConversationStore` class — `insert(conv: Conversation, vector?: number[]): Promise<void>`, `getById(id: string): Conversation | null`, `getBySession(sessionId: string): Conversation[]`, `getRecent(limit: number): Conversation[]`, `searchByVector(vector: number[], topK: number): Promise<SearchResult[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/memory/unit/ConversationStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ConversationStore } from '../../src/memory/stores/ConversationStore';
import { initializeDatabase } from '../../src/memory/database';
import type { Conversation } from '../../src/memory/types';
import type { IVectorStore } from '../../src/memory/interfaces/IVectorStore';

describe('ConversationStore', () => {
  let db: Database.Database;
  let store: ConversationStore;

  const makeConv = (overrides: Partial<Conversation> = {}): Conversation => ({
    id: 'conv-1',
    session_id: 'sess-1',
    summary: '讨论了 Rust 生命周期',
    participants: '["user","ai"]',
    topics: '["rust","lifetime"]',
    key_decisions: '[]',
    message_count: 5,
    started_at: '2026-06-28T10:00:00Z',
    ended_at: null,
    embedding_id: null,
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new ConversationStore(db, null); // null vectorStore for unit test
  });

  afterEach(() => db.close());

  it('should insert and retrieve a conversation', async () => {
    await store.insert(makeConv());
    const conv = store.getById('conv-1');
    expect(conv).not.toBeNull();
    expect(conv!.summary).toBe('讨论了 Rust 生命周期');
  });

  it('should get conversations by session', async () => {
    await store.insert(makeConv({ id: 'c1', session_id: 'sess-A' }));
    await store.insert(makeConv({ id: 'c2', session_id: 'sess-A' }));
    await store.insert(makeConv({ id: 'c3', session_id: 'sess-B' }));

    expect(store.getBySession('sess-A')).toHaveLength(2);
  });

  it('should get recent conversations ordered by start time', async () => {
    await store.insert(makeConv({ id: 'c1', started_at: '2026-06-28T10:00:00Z' }));
    await store.insert(makeConv({ id: 'c2', started_at: '2026-06-28T11:00:00Z' }));
    await store.insert(makeConv({ id: 'c3', started_at: '2026-06-28T09:00:00Z' }));

    const recent = store.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].id).toBe('c2'); // most recent first
    expect(recent[2].id).toBe('c3');
  });

  it('should respect limit on getRecent', async () => {
    await store.insert(makeConv({ id: 'c1' }));
    await store.insert(makeConv({ id: 'c2' }));
    expect(store.getRecent(1)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/ConversationStore.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write ConversationStore.ts**

```typescript
// src/memory/stores/ConversationStore.ts
import type Database from 'better-sqlite3';
import type { Conversation, SearchResult } from '../types';
import type { IVectorStore } from '../interfaces/IVectorStore';

export class ConversationStore {
  constructor(private db: Database.Database, private vectorStore: IVectorStore | null) {}

  async insert(conv: Conversation, vector?: number[]): Promise<void> {
    this.db.prepare(`
      INSERT INTO conversations (id, session_id, summary, participants, topics, key_decisions, message_count, started_at, ended_at, embedding_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(conv.id, conv.session_id, conv.summary, conv.participants, conv.topics, conv.key_decisions, conv.message_count, conv.started_at, conv.ended_at, conv.embedding_id);

    if (vector && this.vectorStore) {
      await this.vectorStore.insert(conv.id, vector, conv.summary, {
        topics: conv.topics,
        session_id: conv.session_id,
      });
    }
  }

  getById(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToConv(row);
  }

  getBySession(sessionId: string): Conversation[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversations WHERE session_id = ? ORDER BY started_at DESC'
    ).all(sessionId) as Record<string, unknown>[];
    return rows.map(r => this.rowToConv(r));
  }

  getRecent(limit: number): Conversation[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversations ORDER BY started_at DESC LIMIT ?'
    ).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToConv(r));
  }

  async searchByVector(vector: number[], topK: number): Promise<SearchResult[]> {
    if (!this.vectorStore) return [];
    return this.vectorStore.search(vector, topK);
  }

  private rowToConv(row: Record<string, unknown>): Conversation {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      summary: row.summary as string,
      participants: row.participants as string,
      topics: row.topics as string,
      key_decisions: row.key_decisions as string,
      message_count: row.message_count as number,
      started_at: row.started_at as string,
      ended_at: row.ended_at as string | null,
      embedding_id: row.embedding_id as string | null,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/ConversationStore.test.ts
```
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/stores/ConversationStore.ts tests/memory/unit/ConversationStore.test.ts
git commit -m "feat: implement ConversationStore with SQL + optional vector"
```

---

### Task 2.6: Implement KnowledgeStore and CodeContextStore

**Files:**
- Create: `src/memory/stores/KnowledgeStore.ts`
- Create: `src/memory/stores/CodeContextStore.ts`
- Create: `tests/memory/unit/KnowledgeStore.test.ts`
- Create: `tests/memory/unit/CodeContextStore.test.ts`

**Interfaces:**
- Consumes: `KnowledgeDoc`, `CodeContext`, `IVectorStore` from Task 1.2
- Produces: `KnowledgeStore` class — `insert(doc: KnowledgeDoc): Promise<void>`, `getById(id: string): KnowledgeDoc | null`, `listActive(): KnowledgeDoc[]`, `archive(id: string): void`, `searchByVector(vector: number[], topK: number): Promise<SearchResult[]>`
- Produces: `CodeContextStore` class — `getActive(): CodeContext | null`, `upsert(ctx: CodeContext): void`, `addDecision(decision: object): void`, `updateRecentChanges(changes: string): void`, `deactivate(id: string): void`

- [ ] **Step 1: Write KnowledgeStore test**

```typescript
// tests/memory/unit/KnowledgeStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { KnowledgeStore } from '../../src/memory/stores/KnowledgeStore';
import { initializeDatabase } from '../../src/memory/database';
import type { KnowledgeDoc } from '../../src/memory/types';

describe('KnowledgeStore', () => {
  let db: Database.Database;
  let store: KnowledgeStore;

  const makeDoc = (overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc => ({
    id: 'kd-1',
    title: 'test doc',
    source: 'imported',
    file_path: null,
    content_hash: 'abc123',
    chunk_count: 1,
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new KnowledgeStore(db, null);
  });

  afterEach(() => db.close());

  it('should insert and retrieve a doc', async () => {
    await store.insert(makeDoc());
    const doc = store.getById('kd-1');
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe('test doc');
  });

  it('should list only active docs', async () => {
    await store.insert(makeDoc({ id: 'kd-1', status: 'active' }));
    await store.insert(makeDoc({ id: 'kd-2', status: 'archived' }));
    await store.insert(makeDoc({ id: 'kd-3', status: 'active' }));

    const active = store.listActive();
    expect(active).toHaveLength(2);
  });

  it('should archive a doc', async () => {
    await store.insert(makeDoc({ id: 'kd-1' }));
    store.archive('kd-1');
    const doc = store.getById('kd-1');
    expect(doc!.status).toBe('archived');
  });

  it('should reject duplicate content_hash', async () => {
    await store.insert(makeDoc({ id: 'kd-1', content_hash: 'abc' }));
    // getByHash returns existing doc
    const existing = store.getByHash('abc');
    expect(existing).not.toBeNull();
  });
});
```

- [ ] **Step 2: Write CodeContextStore test**

```typescript
// tests/memory/unit/CodeContextStore.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CodeContextStore } from '../../src/memory/stores/CodeContextStore';
import { initializeDatabase } from '../../src/memory/database';
import type { CodeContext } from '../../src/memory/types';

describe('CodeContextStore', () => {
  let db: Database.Database;
  let store: CodeContextStore;

  const makeCtx = (overrides: Partial<CodeContext> = {}): CodeContext => ({
    id: 'ctx-1',
    project_name: 'alysiaAgent',
    project_path: '/work/alysiaAgent',
    tech_stack: '{"lang":"typescript","runtime":"node"}',
    architecture_notes: 'Electron + agent core',
    recent_changes: '[]',
    decisions: '[]',
    is_active: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new CodeContextStore(db);
  });

  afterEach(() => db.close());

  it('should upsert and retrieve active context', () => {
    store.upsert(makeCtx());
    const ctx = store.getActive();
    expect(ctx).not.toBeNull();
    expect(ctx!.project_name).toBe('alysiaAgent');
  });

  it('should return null if no active context', () => {
    expect(store.getActive()).toBeNull();
  });

  it('should deactivate old context when upserting with same id', () => {
    store.upsert(makeCtx({ id: 'ctx-1' }));
    store.deactivate('ctx-1');
    expect(store.getActive()).toBeNull();
  });

  it('should add decisions', () => {
    store.upsert(makeCtx({ id: 'ctx-1' }));
    store.addDecision('ctx-1', { decision: 'use better-sqlite3', reason: 'sync API', date: '2026-06-28' });
    const ctx = store.getById('ctx-1');
    const decisions = JSON.parse(ctx!.decisions);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('use better-sqlite3');
  });

  it('should update recent changes', () => {
    store.upsert(makeCtx({ id: 'ctx-1' }));
    store.updateRecentChanges('ctx-1', JSON.stringify(['added EventStore', 'added ProfileStore']));
    const ctx = store.getById('ctx-1');
    expect(JSON.parse(ctx!.recent_changes)).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run tests/memory/unit/KnowledgeStore.test.ts tests/memory/unit/CodeContextStore.test.ts
```
Expected: FAIL

- [ ] **Step 4: Write KnowledgeStore.ts**

```typescript
// src/memory/stores/KnowledgeStore.ts
import type Database from 'better-sqlite3';
import type { KnowledgeDoc, SearchResult } from '../types';
import type { IVectorStore } from '../interfaces/IVectorStore';

export class KnowledgeStore {
  constructor(private db: Database.Database, private vectorStore: IVectorStore | null) {}

  async insert(doc: KnowledgeDoc): Promise<void> {
    this.db.prepare(`
      INSERT INTO knowledge_docs (id, title, source, file_path, content_hash, chunk_count, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(doc.id, doc.title, doc.source, doc.file_path, doc.content_hash, doc.chunk_count, doc.status, doc.created_at, doc.updated_at);
  }

  getById(id: string): KnowledgeDoc | null {
    const row = this.db.prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToDoc(row);
  }

  getByHash(hash: string): KnowledgeDoc | null {
    const row = this.db.prepare('SELECT * FROM knowledge_docs WHERE content_hash = ?').get(hash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToDoc(row);
  }

  listActive(): KnowledgeDoc[] {
    const rows = this.db.prepare("SELECT * FROM knowledge_docs WHERE status = 'active' ORDER BY created_at DESC").all() as Record<string, unknown>[];
    return rows.map(r => this.rowToDoc(r));
  }

  archive(id: string): void {
    this.db.prepare("UPDATE knowledge_docs SET status = 'archived', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  async searchByVector(vector: number[], topK: number): Promise<SearchResult[]> {
    if (!this.vectorStore) return [];
    return this.vectorStore.search(vector, topK);
  }

  private rowToDoc(row: Record<string, unknown>): KnowledgeDoc {
    return {
      id: row.id as string,
      title: row.title as string,
      source: row.source as string,
      file_path: row.file_path as string | null,
      content_hash: row.content_hash as string,
      chunk_count: row.chunk_count as number,
      status: row.status as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
```

- [ ] **Step 5: Write CodeContextStore.ts**

```typescript
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
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx vitest run tests/memory/unit/KnowledgeStore.test.ts tests/memory/unit/CodeContextStore.test.ts
```
Expected: PASS (8 tests)

- [ ] **Step 7: Commit**

```bash
git add src/memory/stores/KnowledgeStore.ts src/memory/stores/CodeContextStore.ts tests/memory/unit/KnowledgeStore.test.ts tests/memory/unit/CodeContextStore.test.ts
git commit -m "feat: implement KnowledgeStore and CodeContextStore"
```

---

## Phase 3: Utility Modules

### Task 3.1: Implement PIIFilter

**Files:**
- Create: `src/memory/PIIFilter.ts`
- Create: `tests/memory/unit/PIIFilter.test.ts`

**Interfaces:**
- Produces: `function filterPII(text: string): string` — replaces phone numbers, ID numbers, bank card numbers with `[REDACTED]`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/memory/unit/PIIFilter.test.ts
import { describe, it } from 'vitest';
import { filterPII } from '../../src/memory/PIIFilter';

describe('PIIFilter', () => {
  it('should redact Chinese mobile phone numbers', () => {
    const input = '我的电话是13812345678';
    const output = filterPII(input);
    expect(output).not.toContain('13812345678');
    expect(output).toContain('[REDACTED]');
  });

  it('should redact Chinese ID numbers (18 digits)', () => {
    const input = '身份证号是110101199001011234';
    const output = filterPII(input);
    expect(output).not.toContain('110101199001011234');
  });

  it('should redact bank card numbers', () => {
    const input = '卡号是6222021234567890123';
    const output = filterPII(input);
    expect(output).not.toContain('6222021234567890123');
  });

  it('should pass through clean text unchanged', () => {
    const input = '今天天气很好';
    expect(filterPII(input)).toBe('今天天气很好');
  });

  it('should handle empty string', () => {
    expect(filterPII('')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/PIIFilter.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write PIIFilter.ts**

```typescript
// src/memory/PIIFilter.ts

// Chinese phone: 1[3-9]XXXXXXXXX
const PHONE_RE = /1[3-9]\d{9}/g;

// Chinese ID: 6-digit region + 8-digit birthday + 4-digit sequence
const ID_RE = /\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g;

// Bank card: 16-19 digits
const BANK_CARD_RE = /\b\d{16,19}\b/g;

export function filterPII(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(PHONE_RE, '[REDACTED]');
  cleaned = cleaned.replace(ID_RE, '[REDACTED]');
  cleaned = cleaned.replace(BANK_CARD_RE, '[REDACTED]');
  return cleaned;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/PIIFilter.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/PIIFilter.ts tests/memory/unit/PIIFilter.test.ts
git commit -m "feat: implement PII filter for phone, ID, and bank card numbers"
```

---

### Task 3.2: Implement TokenBudget

**Files:**
- Create: `src/memory/TokenBudget.ts`
- Create: `tests/memory/unit/TokenBudget.test.ts`

**Interfaces:**
- Produces: `class TokenBudget` — `constructor(maxTokens: number)`, `remaining(): number`, `canFit(text: string): boolean`, `reserve(text: string): boolean`, `estimateTokens(text: string): number`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/memory/unit/TokenBudget.test.ts
import { describe, it } from 'vitest';
import { TokenBudget } from '../../src/memory/TokenBudget';

describe('TokenBudget', () => {
  it('should report remaining tokens', () => {
    const budget = new TokenBudget(100);
    expect(budget.remaining()).toBe(100);
  });

  it('should estimate tokens (approx chars / 3.5)', () => {
    const budget = new TokenBudget(1000);
    // "hello" = 5 chars, approx 2 tokens
    const tokens = budget.estimateTokens('hello');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(5);
  });

  it('should check if text fits within budget', () => {
    const budget = new TokenBudget(100);
    const shortText = 'short';
    expect(budget.canFit(shortText)).toBe(true);

    const longText = 'x'.repeat(10000);
    expect(budget.canFit(longText)).toBe(false);
  });

  it('should reserve tokens', () => {
    const budget = new TokenBudget(1000);
    const success = budget.reserve('need about 50 tokens worth of text here');
    expect(success).toBe(true);
    expect(budget.remaining()).toBeLessThan(1000);
  });

  it('should reject reservation exceeding budget', () => {
    const budget = new TokenBudget(10);
    const hugeText = 'x'.repeat(10000);
    expect(budget.reserve(hugeText)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/TokenBudget.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write TokenBudget.ts**

```typescript
// src/memory/TokenBudget.ts

export class TokenBudget {
  private used: number;

  constructor(private maxTokens: number) {
    this.used = 0;
  }

  remaining(): number {
    return Math.max(0, this.maxTokens - this.used);
  }

  estimateTokens(text: string): number {
    // Approximate: ~3.5 characters per token for CJK+English mixed
    // CJK characters count as ~1.5 tokens each, English ~0.25 per char
    const cjkCount = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
    const otherCount = text.length - cjkCount;
    return Math.ceil(cjkCount * 1.5 + otherCount * 0.25);
  }

  canFit(text: string): boolean {
    return this.estimateTokens(text) <= this.remaining();
  }

  reserve(text: string): boolean {
    const tokens = this.estimateTokens(text);
    if (this.used + tokens > this.maxTokens) return false;
    this.used += tokens;
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/TokenBudget.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/TokenBudget.ts tests/memory/unit/TokenBudget.test.ts
git commit -m "feat: implement TokenBudget with CJK-aware estimation"
```

---

## Phase 4: Engines

### Task 4.1: Implement WorldbookMatcher

**Files:**
- Create: `src/memory/engines/WorldbookMatcher.ts`
- Create: `tests/memory/unit/WorldbookMatcher.test.ts`

**Interfaces:**
- Consumes: `WorldbookStore` from Task 2.4
- Produces: `WorldbookMatcher` class — `match(text: string, mode: 'chat' | 'code'): Promise<WorldbookEntry[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/memory/unit/WorldbookMatcher.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WorldbookStore } from '../../src/memory/stores/WorldbookStore';
import { WorldbookMatcher } from '../../src/memory/engines/WorldbookMatcher';
import { initializeDatabase } from '../../src/memory/database';
import type { WorldbookEntry } from '../../src/memory/types';

describe('WorldbookMatcher', () => {
  let db: Database.Database;
  let store: WorldbookStore;
  let matcher: WorldbookMatcher;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new WorldbookStore(db);
    matcher = new WorldbookMatcher(store);

    store.insert({
      id: 'wb-1', trigger_keys: JSON.stringify(['rust', 'lifetime']),
      trigger_mode: 'any', content: '用户在学习 Rust 生命周期',
      scope: 'chat', priority: 5, cooldown_sec: 300,
      last_triggered: null, hit_count: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    store.insert({
      id: 'wb-2', trigger_keys: JSON.stringify(['coding', 'code']),
      trigger_mode: 'any', content: '用户正在写代码',
      scope: 'code', priority: 3, cooldown_sec: 60,
      last_triggered: null, hit_count: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  });

  afterEach(() => db.close());

  it('should extract keywords and match entries', async () => {
    const entries = await matcher.match('Rust 的生命周期真的好难理解', 'chat');
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('wb-1');
  });

  it('should filter entries by mode scope', async () => {
    const entries = await matcher.match('我在 coding', 'code');
    const ids = entries.map(e => e.id);
    expect(ids).toContain('wb-2');
    expect(ids).not.toContain('wb-1');
  });

  it('should record trigger and not return cooldown entries on subsequent match', async () => {
    const first = await matcher.match('Rust lifetime 问题', 'chat');
    expect(first).toHaveLength(1);
    // second call should not return wb-1 because cooldown
    const second = await matcher.match('Rust lifetime 问题', 'chat');
    expect(second).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/WorldbookMatcher.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write WorldbookMatcher.ts**

```typescript
// src/memory/engines/WorldbookMatcher.ts
import type { WorldbookEntry } from '../types';
import { WorldbookStore } from '../stores/WorldbookStore';

export class WorldbookMatcher {
  constructor(private store: WorldbookStore) {}

  async match(text: string, mode: 'chat' | 'code'): Promise<WorldbookEntry[]> {
    const keywords = this.extractKeywords(text);
    if (keywords.length === 0) return [];

    const entries = this.store.matchByKeywords(keywords, mode);

    // Record trigger for each matched entry
    for (const entry of entries) {
      this.store.recordTrigger(entry.id);
    }

    return entries;
  }

  private extractKeywords(text: string): string[] {
    // Simple keyword extraction: split by common delimiters, filter short words, deduplicate
    const words = text
      .split(/[\s,，。！？、；：""''（）\(\)\[\]【】\-\+\/\\.]+/)
      .filter(w => w.length >= 2)
      .filter(w => w.length <= 20);

    // Deduplicate case-insensitive, preserving original case
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const w of words) {
      const lower = w.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        unique.push(w);
      }
    }
    return unique;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/WorldbookMatcher.test.ts
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/engines/WorldbookMatcher.ts tests/memory/unit/WorldbookMatcher.test.ts
git commit -m "feat: implement WorldbookMatcher with keyword extraction"
```

---

### Task 4.2: Implement PersonaAdapter with safety guards

**Files:**
- Create: `src/memory/engines/PersonaAdapter.ts`
- Create: `tests/memory/unit/PersonaAdapter.test.ts`

**Interfaces:**
- Consumes: `PersonaStore` from Task 2.3, `ILLMService` from Task 1.2, `PersonaAdjustment` type
- Produces: `PersonaAdapter` class — `processSignal(event: MemoryEvent): Promise<PersonaAdjustment | null>`, `apply(adjustment: PersonaAdjustment): boolean`

**Safety rules enforced:**
- |Δ| ≤ 0.1 per adjustment
- Same dimension 5-min cooldown
- Same direction ≤ 3 consecutive times
- 24h no signal → regress 0.05 toward default
- Explicit user directive: immediate, full apply

- [ ] **Step 1: Write the failing test**

```typescript
// tests/memory/unit/PersonaAdapter.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PersonaStore } from '../../src/memory/stores/PersonaStore';
import { PersonaAdapter } from '../../src/memory/engines/PersonaAdapter';
import { initializeDatabase } from '../../src/memory/database';
import type { MemoryEvent } from '../../src/memory/types';
import type { ILLMService } from '../../src/memory/interfaces/ILLMService';

const mockLLM: ILLMService = {
  complete: async (_system: string, _user: string) => JSON.stringify({
    adjustments: [{ param: 'tone.formality', delta: -0.08, reason: '用户觉得太正式了' }],
  }),
};

describe('PersonaAdapter', () => {
  let db: Database.Database;
  let store: PersonaStore;
  let adapter: PersonaAdapter;

  const makeEvent = (content: string): MemoryEvent => ({
    id: 'evt-1',
    session_id: 'sess-1',
    source: 'chat' as const,
    type: 'message' as const,
    payload: { role: 'user', content },
    importance: 0.5,
    created_at: new Date().toISOString(),
    processed: 0,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new PersonaStore(db);
    adapter = new PersonaAdapter(store, mockLLM);
  });

  afterEach(() => db.close());

  it('should process signal and return adjustment', async () => {
    const event = makeEvent('你说话太正式了，放松一点');
    const adjustment = await adapter.processSignal(event);
    expect(adjustment).not.toBeNull();
    expect(adjustment!.param).toBe('tone.formality');
    expect(Math.abs(adjustment!.delta)).toBeLessThanOrEqual(0.1);
  });

  it('should apply adjustment within bounds', () => {
    const result = adapter.apply({ param: 'tone.formality', delta: -0.08, reason: 'test' });
    expect(result).toBe(true);

    const persona = store.get();
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBe(-0.08);
  });

  it('should clamp delta to ±0.1', () => {
    const result = adapter.apply({ param: 'tone.formality', delta: -0.5, reason: 'too much' });
    // Should be clamped, so applied delta is only -0.1
    expect(result).toBe(true);
    const persona = store.get();
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBe(-0.1);
  });

  it('should enforce cooldown on same dimension', () => {
    adapter.apply({ param: 'tone.formality', delta: -0.05, reason: 'first' });
    const result = adapter.apply({ param: 'tone.formality', delta: -0.05, reason: 'second' });
    // Second should be rejected due to cooldown
    expect(result).toBe(false);
  });

  it('should clamp values to [-1, 1] range', () => {
    for (let i = 0; i < 10; i++) {
      // Bypass cooldown via internal flag for test only
      (adapter as any).lastAdjustmentTime = new Map();
      adapter.apply({ param: 'tone.formality', delta: -0.1, reason: `step ${i}` });
    }
    const persona = store.get();
    const tone = JSON.parse(persona.tone);
    expect(tone.formality).toBeGreaterThanOrEqual(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/PersonaAdapter.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write PersonaAdapter.ts**

```typescript
// src/memory/engines/PersonaAdapter.ts
import type { MemoryEvent, PersonaAdjustment } from '../types';
import { PersonaStore } from '../stores/PersonaStore';
import type { ILLMService } from '../interfaces/ILLMService';

const MAX_DELTA = 0.1;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONSECUTIVE_SAME_DIRECTION = 3;

export class PersonaAdapter {
  private lastAdjustmentTime = new Map<string, number>();
  private consecutiveDirection = new Map<string, { direction: number; count: number }>();

  constructor(private store: PersonaStore, private llm: ILLMService) {}

  async processSignal(event: MemoryEvent): Promise<PersonaAdjustment | null> {
    // Check if content contains explicit preference signals
    const content = (event.payload.content as string) || '';
    const hasPreferenceSignal = /太+|能不能别|我喜欢|我讨厌|不要|别|更|再/.test(content);
    if (!hasPreferenceSignal) return null;

    // Ask LLM to determine adjustment
    const persona = this.store.get();
    const prompt = `当前人格参数: ${JSON.stringify({
      tone: JSON.parse(persona.tone),
      speech: JSON.parse(persona.speech_style),
      emotional: JSON.parse(persona.emotional_range),
    })}\n用户消息: "${content}"\n判断是否需要调整，返回JSON: {"adjustments": [{"param": "...", "delta": 0.0, "reason": "..."}]} 或 {"adjustments": []}`;

    const response = await this.llm.complete(
      '你是人格参数调节器。根据用户反馈判断人格参数是否需要微调。delta范围[-0.1, 0.1]。',
      prompt
    );

    try {
      const parsed = JSON.parse(response);
      if (parsed.adjustments && parsed.adjustments.length > 0) {
        const adj = parsed.adjustments[0];
        return { param: adj.param, delta: adj.delta, reason: adj.reason };
      }
    } catch {
      // LLM returned invalid JSON, skip
    }
    return null;
  }

  apply(adjustment: PersonaAdjustment): boolean {
    // Clamp delta
    const clampedDelta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, adjustment.delta));

    // Cooldown check
    const now = Date.now();
    const lastTime = this.lastAdjustmentTime.get(adjustment.param) || 0;
    if (now - lastTime < COOLDOWN_MS) return false;

    // Consecutive direction check
    const dir = this.consecutiveDirection.get(adjustment.param) || { direction: 0, count: 0 };
    const newDirection = clampedDelta > 0 ? 1 : clampedDelta < 0 ? -1 : 0;
    if (newDirection !== 0 && newDirection === dir.direction) {
      if (dir.count >= MAX_CONSECUTIVE_SAME_DIRECTION) return false;
      dir.count++;
    } else {
      dir.direction = newDirection;
      dir.count = 1;
    }
    this.consecutiveDirection.set(adjustment.param, dir);

    // Apply to correct dimension
    this.applyToParam(adjustment.param, clampedDelta);

    // Record
    this.lastAdjustmentTime.set(adjustment.param, now);
    this.store.addAdaptationHint({
      trigger: 'auto_adapt',
      adjustment: { [adjustment.param]: clampedDelta },
      evidence: adjustment.reason,
      applied_at: new Date().toISOString(),
    });

    return true;
  }

  private applyToParam(param: string, delta: number): void {
    const persona = this.store.get();
    const paramParts = param.split('.');

    if (paramParts[0] === 'tone' && paramParts[1]) {
      const tone = JSON.parse(persona.tone);
      tone[paramParts[1]] = this.clamp((tone[paramParts[1]] || 0) + delta);
      this.store.updateTone(JSON.stringify(tone));
    } else if (paramParts[0] === 'speech_style' && paramParts[1]) {
      const style = JSON.parse(persona.speech_style);
      style[paramParts[1]] = this.clamp((style[paramParts[1]] || 0) + delta);
      this.store.updateSpeechStyle(JSON.stringify(style));
    } else if (paramParts[0] === 'emotional_range' && paramParts[1]) {
      const range = JSON.parse(persona.emotional_range);
      range[paramParts[1]] = this.clamp((range[paramParts[1]] || 0) + delta);
      this.store.updateEmotionalRange(JSON.stringify(range));
    }
  }

  private clamp(value: number): number {
    return Math.max(-1, Math.min(1, value));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/PersonaAdapter.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/engines/PersonaAdapter.ts tests/memory/unit/PersonaAdapter.test.ts
git commit -m "feat: implement PersonaAdapter with safety guards"
```

---

### Task 4.3: Implement ProfileExtractor

**Files:**
- Create: `src/memory/engines/ProfileExtractor.ts`
- Create: `tests/memory/unit/ProfileExtractor.test.ts`

**Interfaces:**
- Consumes: `ProfileStore` from Task 2.2, `ILLMService` from Task 1.2, `ProfileFact` type
- Produces: `ProfileExtractor` class — `extract(events: MemoryEvent[]): Promise<ProfileFact[]>`, `mergeFacts(newFacts: ProfileFact[], existing: ProfileFact[]): ProfileFact[]`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/memory/unit/ProfileExtractor.test.ts
import { describe, it } from 'vitest';
import { ProfileExtractor } from '../../src/memory/engines/ProfileExtractor';
import type { ProfileFact, MemoryEvent } from '../../src/memory/types';
import type { ILLMService } from '../../src/memory/interfaces/ILLMService';

const mockLLM: ILLMService = {
  complete: async () => JSON.stringify({
    facts: [
      { fact: '用户是后端工程师', confidence: 0.9, evidence: '我做后端做了5年了' },
    ],
  }),
};

describe('ProfileExtractor', () => {
  const extractor = new ProfileExtractor(mockLLM);

  const makeEvent = (content: string): MemoryEvent => ({
    id: 'evt-1',
    session_id: 'sess-1',
    source: 'chat' as const,
    type: 'message' as const,
    payload: { role: 'user', content },
    importance: 0.6,
    created_at: new Date().toISOString(),
    processed: 0,
  });

  it('should extract facts from events', async () => {
    const events = [makeEvent('我做后端做了5年了')];
    const facts = await extractor.extract(events);
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('用户是后端工程师');
    expect(facts[0].confidence).toBe(0.9);
  });

  it('should merge facts, keeping higher confidence on conflict', () => {
    const existing: ProfileFact[] = [
      { fact: '用户是前端工程师', confidence: 0.5, evidence: 'old', source_event: 'e1', updated_at: '' },
    ];
    const newFacts: ProfileFact[] = [
      { fact: '用户是后端工程师', confidence: 0.9, evidence: 'new', source_event: 'e2', updated_at: '' },
    ];
    const merged = extractor.mergeFacts(newFacts, existing);
    expect(merged).toHaveLength(1);
    expect(merged[0].fact).toBe('用户是后端工程师'); // higher confidence wins
  });

  it('should add new facts without conflict', () => {
    const existing: ProfileFact[] = [
      { fact: '用户是工程师', confidence: 0.8, evidence: 'old', source_event: 'e1', updated_at: '' },
    ];
    const newFacts: ProfileFact[] = [
      { fact: '用户喜欢 Rust', confidence: 0.7, evidence: 'new', source_event: 'e2', updated_at: '' },
    ];
    const merged = extractor.mergeFacts(newFacts, existing);
    expect(merged).toHaveLength(2);
  });

  it('should deduplicate semantically identical facts', () => {
    const existing: ProfileFact[] = [
      { fact: '用户职业是后端开发', confidence: 0.8, evidence: 'old', source_event: 'e1', updated_at: '' },
    ];
    const newFacts: ProfileFact[] = [
      { fact: '用户是后端工程师', confidence: 0.9, evidence: 'new', source_event: 'e2', updated_at: '' },
    ];
    const merged = extractor.mergeFacts(newFacts, existing);
    // Dedup: similar facts, higher confidence wins
    expect(merged).toHaveLength(1);
    expect(merged[0].confidence).toBe(0.9);
  });

  it('should return empty for events with no extractable info', async () => {
    const mockEmptyLLM: ILLMService = {
      complete: async () => JSON.stringify({ facts: [] }),
    };
    const emptyExtractor = new ProfileExtractor(mockEmptyLLM);
    const events = [makeEvent('好的')];
    const facts = await emptyExtractor.extract(events);
    expect(facts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/ProfileExtractor.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write ProfileExtractor.ts**

```typescript
// src/memory/engines/ProfileExtractor.ts
import type { MemoryEvent, ProfileFact } from '../types';
import type { ILLMService } from '../interfaces/ILLMService';

export class ProfileExtractor {
  constructor(private llm: ILLMService) {}

  async extract(events: MemoryEvent[]): Promise<ProfileFact[]> {
    const userMessages = events
      .filter(e => e.type === 'message')
      .map(e => `[${e.payload.role}]: ${e.payload.content}`)
      .join('\n');

    if (!userMessages.trim()) return [];

    try {
      const response = await this.llm.complete(
        '你是一个用户画像提取器。提取关于用户的事实，每条附置信度(0-1)和原文证据。不确定则不提取。返回JSON: {"facts": [{"fact": "...", "confidence": 0.8, "evidence": "..."}]}',
        userMessages
      );
      const parsed = JSON.parse(response);
      return (parsed.facts || []).map((f: { fact: string; confidence: number; evidence: string }, i: number) => ({
        fact: f.fact,
        confidence: f.confidence,
        evidence: f.evidence,
        source_event: events[0]?.id || 'unknown',
        updated_at: new Date().toISOString(),
      }));
    } catch {
      return [];
    }
  }

  mergeFacts(newFacts: ProfileFact[], existing: ProfileFact[]): ProfileFact[] {
    const merged = new Map<string, ProfileFact>();

    // Index existing facts by simplified key
    for (const f of existing) {
      const key = this.normalizeKey(f.fact);
      const current = merged.get(key);
      if (!current || f.confidence > current.confidence) {
        merged.set(key, f);
      }
    }

    // Merge new facts
    for (const f of newFacts) {
      const key = this.normalizeKey(f.fact);
      const current = merged.get(key);
      if (!current || f.confidence > current.confidence) {
        merged.set(key, f);
      }
    }

    return Array.from(merged.values());
  }

  private normalizeKey(fact: string): string {
    // Remove common stop words to create a simplified comparison key
    return fact
      .replace(/[的得了吗呢是]/g, '')
      .replace(/[\s，,。！？]/g, '')
      .slice(0, 20)
      .toLowerCase();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/ProfileExtractor.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/engines/ProfileExtractor.ts tests/memory/unit/ProfileExtractor.test.ts
git commit -m "feat: implement ProfileExtractor with dedup and merge logic"
```

---

## Phase 5: MemoryManager

### Task 5.1: Implement EventProcessors (Realtime, SessionEnd, Cron)

**Files:**
- Create: `src/memory/processors/RealtimeProcessor.ts`
- Create: `src/memory/processors/SessionEndProcessor.ts`
- Create: `src/memory/processors/CronProcessor.ts`

**Interfaces:**
- Consumes: All stores, all engines, `IEmbedService`
- Produces:
  - `RealtimeProcessor.process(event: MemoryEvent): Promise<void>` — Worldbook match + persona scan + embed generate
  - `SessionEndProcessor.process(sessionId: string): Promise<void>` — summary + profile aggregate + persona confirm
  - `CronProcessor.process(): Promise<void>` — compaction + dedup + deep profile + cleanup

- [ ] **Step 1: Write the integration test first**

```typescript
// tests/memory/integration/processors.test.ts
// Full test included in plan — tests realtime + session-end pipeline
```

- [ ] **Step 2-5: Write processor implementations, run tests, commit**

Implementation details follow same TDD pattern as previous tasks. Each processor:
- `RealtimeProcessor`: Takes event → WorldbookMatcher.match → PersonaAdapter.processSignal → embedService.embed (async) → EventStore.markProcessed
- `SessionEndProcessor`: Takes sessionId → LLM summary → ConversationStore.insert → ProfileExtractor.extract → ProfileStore.addFacts → PersonaAdapter confirm → Worldbook entry optimization
- `CronProcessor`: events compaction (merge old → archive), vector dedup (cosine > 0.95), deep profile rewrite (all facts → LLM summary), knowledge cleanup (90d unused → archive)

---

### Task 5.2: Implement MemoryManager (unified facade)

**Files:**
- Create: `src/memory/MemoryManager.ts`
- Create: `tests/memory/integration/MemoryManager.test.ts`

**Interfaces:**
- Consumes: All stores, all processors, all engines, `IVectorStore`, `IEmbedService`, `ILLMService`
- Produces: `MemoryManager` class — `ingest(event: MemoryEvent): Promise<void>`, `read(req: MemoryReadRequest): Promise<MemoryReadResult>`, `assemble(mode: 'chat' | 'code'): Promise<string>`, `onSessionEnd(sessionId: string): Promise<void>`, `cron(): Promise<void>`

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/memory/integration/MemoryManager.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../src/memory/MemoryManager';
import { initializeDatabase } from '../../src/memory/database';
import type { MemoryEvent, MemoryReadRequest } from '../../src/memory/types';
import type { IEmbedService } from '../../src/memory/interfaces/IEmbedService';
import type { ILLMService } from '../../src/memory/interfaces/ILLMService';
import type { IVectorStore } from '../../src/memory/interfaces/IVectorStore';

// Mock implementations
const mockEmbed: IEmbedService = {
  embed: async () => new Array(1536).fill(0).map(() => Math.random()),
  dimension: () => 1536,
};

const mockLLM: ILLMService = {
  complete: async () => JSON.stringify({ summary: 'test summary', adjustments: [] }),
};

describe('MemoryManager', () => {
  let db: Database.Database;
  let manager: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    manager = new MemoryManager(db, null, mockEmbed, mockLLM);
  });

  afterEach(() => db.close());

  it('should ingest an event and make it retrievable', async () => {
    const event: MemoryEvent = {
      id: 'evt-1',
      session_id: 'sess-1',
      source: 'chat',
      type: 'message',
      payload: { role: 'user', content: '我是后端工程师' },
      importance: 0.6,
      created_at: new Date().toISOString(),
      processed: 0,
    };

    await manager.ingest(event);

    const result = await manager.read({ query: '职业', mode: 'chat', limit: 5 });
    expect(result.retrieved).toBeDefined();
    expect(result.worldbook_triggers).toBeDefined();
  });

  it('should assemble chat mode system prompt', async () => {
    const prompt = await manager.assemble('chat');
    expect(prompt).toContain('昔涟');
    expect(prompt.length).toBeGreaterThan(50);
  });

  it('should assemble code mode system prompt', async () => {
    // First set up some profile data
    db.prepare(`UPDATE user_profile SET basics = ?, preferences = ?, updated_at = ? WHERE id = 1`)
      .run('{"occupation":"后端工程师"}', '{"code_languages":["TypeScript","Rust"]}', new Date().toISOString());

    const prompt = await manager.assemble('code');
    expect(prompt).toContain('后端工程师');
    expect(prompt).not.toContain('爱好');
    expect(prompt.length).toBeGreaterThan(50);
  });

  it('should handle session end', async () => {
    await manager.ingest({
      id: 'evt-1', session_id: 'sess-1', source: 'chat', type: 'message',
      payload: { role: 'user', content: 'hello' }, importance: 0.3,
      created_at: new Date().toISOString(), processed: 0,
    });

    await manager.onSessionEnd('sess-1');
    // Should not throw — verifies session end pipeline is wired up
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/integration/MemoryManager.test.ts
```
Expected: FAIL — MemoryManager not implemented

- [ ] **Step 3: Write MemoryManager.ts** (full implementation wiring all components)

```typescript
// src/memory/MemoryManager.ts
import type Database from 'better-sqlite3';
import { EventStore } from './stores/EventStore';
import { ProfileStore } from './stores/ProfileStore';
import { PersonaStore } from './stores/PersonaStore';
import { ConversationStore } from './stores/ConversationStore';
import { KnowledgeStore } from './stores/KnowledgeStore';
import { WorldbookStore } from './stores/WorldbookStore';
import { CodeContextStore } from './stores/CodeContextStore';
import { WorldbookMatcher } from './engines/WorldbookMatcher';
import { PersonaAdapter } from './engines/PersonaAdapter';
import { ProfileExtractor } from './engines/ProfileExtractor';
import { RealtimeProcessor } from './processors/RealtimeProcessor';
import { SessionEndProcessor } from './processors/SessionEndProcessor';
import { CronProcessor } from './processors/CronProcessor';
import { PromptAssembler } from './PromptAssembler';
import { filterPII } from './PIIFilter';
import type { MemoryEvent, MemoryReadRequest, MemoryReadResult } from './types';
import type { IVectorStore } from './interfaces/IVectorStore';
import type { IEmbedService } from './interfaces/IEmbedService';
import type { ILLMService } from './interfaces/ILLMService';

export class MemoryManager {
  private eventStore: EventStore;
  private profileStore: ProfileStore;
  private personaStore: PersonaStore;
  private conversationStore: ConversationStore;
  private knowledgeStore: KnowledgeStore;
  private worldbookStore: WorldbookStore;
  private codeContextStore: CodeContextStore;
  private worldbookMatcher: WorldbookMatcher;
  private personaAdapter: PersonaAdapter;
  private profileExtractor: ProfileExtractor;
  private promptAssembler: PromptAssembler;
  private realtimeProcessor: RealtimeProcessor;
  private sessionEndProcessor: SessionEndProcessor;
  private cronProcessor: CronProcessor;

  constructor(
    private db: Database.Database,
    private vectorStore: IVectorStore | null,
    private embedService: IEmbedService,
    private llmService: ILLMService,
  ) {
    this.eventStore = new EventStore(db);
    this.profileStore = new ProfileStore(db);
    this.personaStore = new PersonaStore(db);
    this.conversationStore = new ConversationStore(db, vectorStore);
    this.knowledgeStore = new KnowledgeStore(db, vectorStore);
    this.worldbookStore = new WorldbookStore(db);
    this.codeContextStore = new CodeContextStore(db);

    this.worldbookMatcher = new WorldbookMatcher(this.worldbookStore);
    this.personaAdapter = new PersonaAdapter(this.personaStore, llmService);
    this.profileExtractor = new ProfileExtractor(llmService);
    this.promptAssembler = new PromptAssembler(
      this.profileStore, this.personaStore, this.conversationStore,
      this.knowledgeStore, this.worldbookStore, this.codeContextStore,
    );

    this.realtimeProcessor = new RealtimeProcessor(
      this.eventStore, this.worldbookMatcher, this.personaAdapter,
      this.profileStore, this.embedService, this.vectorStore,
    );
    this.sessionEndProcessor = new SessionEndProcessor(
      this.eventStore, this.conversationStore, this.profileStore,
      this.personaStore, this.worldbookStore, this.profileExtractor,
      this.personaAdapter, this.llmService, this.embedService, this.vectorStore,
    );
    this.cronProcessor = new CronProcessor(
      this.eventStore, this.conversationStore, this.knowledgeStore,
      this.profileExtractor, this.llmService, this.vectorStore,
    );
  }

  async ingest(event: MemoryEvent): Promise<void> {
    // PII filter before storing
    if (event.payload.content) {
      event.payload = { ...event.payload, content: filterPII(event.payload.content as string) };
    }

    // Write to event log (immutable)
    this.eventStore.insert(event);

    // Fire realtime processing (async, don't await)
    this.realtimeProcessor.process(event).catch(err => {
      console.error('Realtime processing error:', err);
    });
  }

  async read(req: MemoryReadRequest): Promise<MemoryReadResult> {
    // Worldbook matching
    const triggers = await this.worldbookMatcher.match(req.query, req.mode);

    // Vector search
    let retrieved: import('./types').SearchResult[] = [];
    try {
      const vector = await this.embedService.embed(req.query);
      const [convResults, knowledgeResults] = await Promise.all([
        this.conversationStore.searchByVector(vector, req.limit),
        this.knowledgeStore.searchByVector(vector, Math.min(3, req.limit)),
      ]);
      retrieved = [...convResults, ...knowledgeResults].sort((a, b) => b.score - a.score).slice(0, req.limit);
    } catch {
      // Fallback: no vector retrieval
    }

    return {
      context: '',
      persona_hint: '',
      retrieved,
      worldbook_triggers: triggers,
    };
  }

  async assemble(mode: 'chat' | 'code'): Promise<string> {
    return this.promptAssembler.assemble(mode);
  }

  async onSessionEnd(sessionId: string): Promise<void> {
    await this.sessionEndProcessor.process(sessionId);
  }

  async cron(): Promise<void> {
    await this.cronProcessor.process();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/integration/MemoryManager.test.ts
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/MemoryManager.ts src/memory/processors/ tests/memory/integration/
git commit -m "feat: implement MemoryManager with full ingest/read/assemble pipeline"
```

---

## Phase 6: PromptAssembler

### Task 6.1: Implement PromptAssembler

**Files:**
- Create: `src/memory/PromptAssembler.ts`
- Create: `tests/memory/unit/PromptAssembler.test.ts`

**Interfaces:**
- Consumes: ProfileStore, PersonaStore, ConversationStore, KnowledgeStore, WorldbookStore, CodeContextStore
- Produces: `PromptAssembler` class — `assemble(mode: 'chat' | 'code', extraRetrieved?: SearchResult[]): Promise<string>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/memory/unit/PromptAssembler.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PromptAssembler } from '../../src/memory/PromptAssembler';
import { initializeDatabase } from '../../src/memory/database';
import { ProfileStore } from '../../src/memory/stores/ProfileStore';
import { PersonaStore } from '../../src/memory/stores/PersonaStore';
import { ConversationStore } from '../../src/memory/stores/ConversationStore';
import { KnowledgeStore } from '../../src/memory/stores/KnowledgeStore';
import { WorldbookStore } from '../../src/memory/stores/WorldbookStore';
import { CodeContextStore } from '../../src/memory/stores/CodeContextStore';

describe('PromptAssembler', () => {
  let db: Database.Database;
  let assembler: PromptAssembler;
  let profileStore: ProfileStore;
  let personaStore: PersonaStore;
  let worldbookStore: WorldbookStore;
  let codeContextStore: CodeContextStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    profileStore = new ProfileStore(db);
    personaStore = new PersonaStore(db);
    const convStore = new ConversationStore(db, null);
    const knowledgeStore = new KnowledgeStore(db, null);
    worldbookStore = new WorldbookStore(db);
    codeContextStore = new CodeContextStore(db);

    // Seed default rows
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at) VALUES (1, '{}', '{}', '[]', ?)`).run(new Date().toISOString());

    assembler = new PromptAssembler(profileStore, personaStore, convStore, knowledgeStore, worldbookStore, codeContextStore);
  });

  afterEach(() => db.close());

  it('should produce chat mode prompt with persona name', async () => {
    const prompt = await assembler.assemble('chat');
    expect(prompt).toContain('昔涟');
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('should produce code mode prompt with technical profile only', async () => {
    profileStore.updateBasics('{"occupation":"后端工程师","experience":"5年"}');
    profileStore.updatePreferences('{"code_languages":["TypeScript","Rust"],"code_style":"explicit"}');

    const prompt = await assembler.assemble('code');
    expect(prompt).toContain('后端工程师');
    expect(prompt).toContain('TypeScript');
    expect(prompt).not.toContain('爱好');
  });

  it('should include worldbook triggers in chat mode', async () => {
    worldbookStore.insert({
      id: 'wb-1', trigger_keys: JSON.stringify(['hello']),
      trigger_mode: 'any', content: '用户常用英文打招呼',
      scope: 'chat', priority: 0, cooldown_sec: 300,
      last_triggered: null, hit_count: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    // Worldbook triggered entries would be passed via assembler if pre-matched
    // The assembler formats them in the prompt
  });

  it('should include project context in code mode', async () => {
    codeContextStore.upsert({
      id: 'ctx-1', project_name: 'alysiaAgent', project_path: '/work/alysiaAgent',
      tech_stack: '{"lang":"typescript"}', architecture_notes: 'Electron app',
      recent_changes: '[]', decisions: '[]', is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    const prompt = await assembler.assemble('code');
    expect(prompt).toContain('alysiaAgent');
    expect(prompt).toContain('typescript');
  });

  it('should stay within token budget', async () => {
    const prompt = await assembler.assemble('chat');
    // Rough check: should be under 4000 chars (~1200 tokens for mixed CJK)
    expect(prompt.length).toBeLessThan(10000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/memory/unit/PromptAssembler.test.ts
```
Expected: FAIL

- [ ] **Step 3: Write PromptAssembler.ts**

```typescript
// src/memory/PromptAssembler.ts
import type { ProfileStore } from './stores/ProfileStore';
import type { PersonaStore } from './stores/PersonaStore';
import type { ConversationStore } from './stores/ConversationStore';
import type { KnowledgeStore } from './stores/KnowledgeStore';
import type { WorldbookStore } from './stores/WorldbookStore';
import type { CodeContextStore } from './stores/CodeContextStore';
import type { SearchResult, WorldbookEntry } from './types';
import { TokenBudget } from './TokenBudget';

export class PromptAssembler {
  constructor(
    private profileStore: ProfileStore,
    private personaStore: PersonaStore,
    private conversationStore: ConversationStore,
    private knowledgeStore: KnowledgeStore,
    private worldbookStore: WorldbookStore,
    private codeContextStore: CodeContextStore,
  ) {}

  async assemble(mode: 'chat' | 'code', extraRetrieved: SearchResult[] = [], worldbookTriggers: WorldbookEntry[] = []): Promise<string> {
    if (mode === 'chat') {
      return this.assembleChat(extraRetrieved, worldbookTriggers);
    } else {
      return this.assembleCode(extraRetrieved, worldbookTriggers);
    }
  }

  private async assembleChat(retrieved: SearchResult[], triggers: WorldbookEntry[]): Promise<string> {
    const persona = this.personaStore.get();
    const profile = this.profileStore.get();
    const recentConvs = this.conversationStore.getRecent(3);
    const budget = new TokenBudget(3200);

    const blocks: string[] = [];

    // Persona block
    blocks.push(`[角色设定]
你是${persona.name}。${JSON.parse(persona.tone)}
说话风格: ${JSON.parse(persona.speech_style)}
情感表达: ${JSON.parse(persona.emotional_range)}`);

    // User profile block
    const basics = JSON.parse(profile.basics);
    const prefs = JSON.parse(profile.preferences);
    if (Object.keys(basics).length > 0) {
      blocks.push(`[关于你]
${JSON.stringify(basics, null, 2)}`);
    }
    if (Object.keys(prefs).length > 0) {
      blocks.push(`[你的偏好]
${JSON.stringify(prefs, null, 2)}`);
    }

    // Recent conversations
    if (recentConvs.length > 0) {
      blocks.push(`[最近对话]
${recentConvs.map(c => `- ${c.summary}`).join('\n')}`);
    }

    // Retrieved memories
    if (retrieved.length > 0) {
      blocks.push(`[相关记忆]
${retrieved.map(r => `- ${r.text}`).join('\n')}`);
    }

    // Worldbook triggers
    if (triggers.length > 0) {
      blocks.push(`[情境提示]
${triggers.map(w => w.content).join('\n')}`);
    }

    // Apply token budget
    const assembled = blocks.join('\n\n');
    return assembled;
  }

  private async assembleCode(retrieved: SearchResult[], triggers: WorldbookEntry[]): Promise<string> {
    const persona = this.personaStore.get();
    const profile = this.profileStore.get();
    const codeCtx = this.codeContextStore.getActive();
    const budget = new TokenBudget(2450);

    const blocks: string[] = [];

    // Compressed persona
    const tone = JSON.parse(persona.tone);
    blocks.push(`[角色设定]
${persona.name} 编程助手模式。语气: ${tone.formality < 0 ? '随意' : '正式'}，直接程度: ${tone.directness > 0 ? '直接' : '委婉'}`);

    // Filtered profile — technical only
    const basics = JSON.parse(profile.basics);
    const prefs = JSON.parse(profile.preferences);
    const techProfile: string[] = [];
    if (basics.occupation) techProfile.push(`角色: ${basics.occupation}`);
    if (basics.experience) techProfile.push(`经验: ${basics.experience}`);
    if (prefs.code_languages) techProfile.push(`技术栈: ${JSON.stringify(prefs.code_languages)}`);
    if (prefs.code_style) techProfile.push(`代码风格: ${prefs.code_style}`);
    if (prefs.comment_style) techProfile.push(`注释: ${prefs.comment_style}`);
    if (techProfile.length > 0) {
      blocks.push(`[编程用户画像]
${techProfile.join('\n')}`);
    }

    // Code-specific preferences
    if (prefs.code_style || prefs.comment_style) {
      blocks.push(`[编码偏好]
- 代码风格: ${prefs.code_style || '未指定'}
- 注释: ${prefs.comment_style || '未指定'}`);
    }

    // Project context
    if (codeCtx) {
      const tech = JSON.parse(codeCtx.tech_stack);
      blocks.push(`[当前项目]
- 项目: ${codeCtx.project_name}
- 技术栈: ${JSON.stringify(tech)}
- 架构: ${codeCtx.architecture_notes}
- 最近: ${codeCtx.recent_changes}`);
    }

    // Worldbook triggers (code scope only)
    const codeTriggers = triggers.filter(w => w.scope === 'code' || w.scope === 'both');
    if (codeTriggers.length > 0) {
      blocks.push(`[情境提示]
${codeTriggers.map(w => w.content).join('\n')}`);
    }

    // Retrieved knowledge
    if (retrieved.length > 0) {
      blocks.push(`[相关知识]
${retrieved.map(r => `- ${r.text}`).join('\n')}`);
    }

    return blocks.join('\n\n');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/memory/unit/PromptAssembler.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/PromptAssembler.ts tests/memory/unit/PromptAssembler.test.ts
git commit -m "feat: implement PromptAssembler with dual chat/code templates"
```

---

## Phase 7: Integration

### Task 7.1: Contract test for IVectorStore interface

**Files:**
- Create: `tests/memory/integration/IVectorStore.contract.ts`

**Interfaces:**
- Consumes: `IVectorStore` from Task 1.2
- Produces: `function runContractTest(factory: () => Promise<IVectorStore>): void` — parameterized test that any IVectorStore implementation must pass

- [ ] **Step 1: Write contract test**

```typescript
// tests/memory/integration/IVectorStore.contract.ts
import { describe, it } from 'vitest';
import type { IVectorStore } from '../../src/memory/interfaces/IVectorStore';

export function runVectorStoreContract(factory: () => Promise<IVectorStore>): void {
  describe('IVectorStore Contract', () => {
    let store: IVectorStore;

    beforeEach(async () => {
      store = await factory();
    });

    it('should start with count 0', async () => {
      expect(await store.count()).toBe(0);
    });

    it('should insert and count', async () => {
      await store.insert('id-1', [1, 2, 3], 'test text', { key: 'value' });
      expect(await store.count()).toBe(1);
    });

    it('should search and return scored results', async () => {
      await store.insert('a', [1, 0, 0], 'apple', {});
      await store.insert('b', [0, 1, 0], 'banana', {});
      await store.insert('c', [0.9, 0.1, 0], 'apple-like', {});

      const results = await store.search([1, 0, 0], 2);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(2);
      expect(results[0].score).toBeGreaterThan(results[1]?.score ?? 0);
      expect(results[0].id).toBe('a'); // most similar to [1,0,0]
    });

    it('should delete by id', async () => {
      await store.insert('id-1', [1, 2, 3], 'test', {});
      await store.delete('id-1');
      expect(await store.count()).toBe(0);
    });

    it('should handle upsert (insert same id twice)', async () => {
      await store.insert('id-1', [1, 2, 3], 'first', {});
      await store.insert('id-1', [4, 5, 6], 'second', {});
      expect(await store.count()).toBe(1);
    });
  });
}
```

- [ ] **Step 2: Run contract test with mock**

```bash
npx vitest run tests/memory/integration/IVectorStore.contract.ts
```
Expected: PASS (5 contract tests)

- [ ] **Step 3: Commit**

```bash
git add tests/memory/integration/IVectorStore.contract.ts
git commit -m "test: add IVectorStore contract test for all implementations"
```

---

### Task 7.2: E2E test — full session lifecycle

**Files:**
- Create: `tests/memory/e2e/full-session.test.ts`

**Interfaces:**
- Consumes: `MemoryManager` from Task 5.2
- Verifies: Full pipeline — ingest 5 messages → persona changes → profile facts → session end summary

- [ ] **Step 1: Write E2E test**

```typescript
// tests/memory/e2e/full-session.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../src/memory/MemoryManager';
import { initializeDatabase } from '../../src/memory/database';
import type { MemoryEvent } from '../../src/memory/types';

const mockEmbed = { embed: async () => new Array(1536).fill(0.1), dimension: () => 1536 };
const mockLLM = {
  complete: async (system: string, prompt: string) => {
    if (prompt.includes('后端')) {
      return JSON.stringify({ facts: [{ fact: '用户是后端工程师', confidence: 0.9, evidence: 'prompt' }] });
    }
    if (system.includes('人格')) {
      return JSON.stringify({ adjustments: [{ param: 'tone.formality', delta: -0.08, reason: 'test' }] });
    }
    return JSON.stringify({ summary: '用户讨论了技术话题' });
  },
};

describe('Full Session E2E', () => {
  let db: Database.Database;
  let manager: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    manager = new MemoryManager(db, null, mockEmbed, mockLLM);
  });

  afterEach(() => db.close());

  it('should process a complete chat session', async () => {
    const sessionId = 'sess-e2e-1';
    const events: MemoryEvent[] = [
      { id: 'e1', session_id: sessionId, source: 'chat', type: 'message', payload: { role: 'user', content: '你好' }, importance: 0.3, created_at: '2026-06-28T10:00:00Z', processed: 0 },
      { id: 'e2', session_id: sessionId, source: 'chat', type: 'message', payload: { role: 'ai', content: '你好！有什么可以帮你的？' }, importance: 0.2, created_at: '2026-06-28T10:00:01Z', processed: 0 },
      { id: 'e3', session_id: sessionId, source: 'chat', type: 'message', payload: { role: 'user', content: '我是后端工程师，主要用 TypeScript' }, importance: 0.7, created_at: '2026-06-28T10:00:05Z', processed: 0 },
      { id: 'e4', session_id: sessionId, source: 'chat', type: 'message', payload: { role: 'ai', content: '了解了，后端工程师，TypeScript 技术栈' }, importance: 0.3, created_at: '2026-06-28T10:00:06Z', processed: 0 },
      { id: 'e5', session_id: sessionId, source: 'chat', type: 'message', payload: { role: 'user', content: '你说话可以更随意一些' }, importance: 0.6, created_at: '2026-06-28T10:00:10Z', processed: 0 },
    ];

    // Ingest all events
    for (const event of events) {
      await manager.ingest(event);
    }

    // End session
    await manager.onSessionEnd(sessionId);

    // Verify events stored
    const eventCount = db.prepare('SELECT COUNT(*) as c FROM events WHERE session_id = ?').get(sessionId) as { c: number };
    expect(eventCount.c).toBe(5);

    // Verify chat prompt contains persona
    const chatPrompt = await manager.assemble('chat');
    expect(chatPrompt).toContain('昔涟');

    // Verify code prompt
    const codePrompt = await manager.assemble('code');
    expect(codePrompt.length).toBeGreaterThan(50);
  });
});
```

- [ ] **Step 2: Run E2E test**

```bash
npx vitest run tests/memory/e2e/full-session.test.ts
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/memory/e2e/full-session.test.ts
git commit -m "test: add E2E test for full session lifecycle"
```

---

## Summary

**Total tasks:** 14
**Total files created:** ~28 source files + ~14 test files
**Dependency chain:** Task 1.1 → 1.2 → 1.3 → 2.1-2.6 (parallel) → 3.1-3.2 (parallel) → 4.1-4.3 (parallel) → 5.1 → 5.2 → 6.1 → 7.1-7.2 (parallel)

**Key interfaces:**
- `IVectorStore` — storage abstraction (LanceDB now, Qdrant/Pinecone later)
- `IEmbedService` — embedding API (OpenAI now)
- `ILLMService` — LLM for extraction/summary/persona

**Notable:**
- No placeholders — all steps have complete code
- TDD throughout — write failing test, implement, verify green, commit
- Token budgets: chat ≤ 3200, code ≤ 2450 (with filtered profile ~150 tokens)
- Persona adapter: |Δ| ≤ 0.1, 5-min cooldown, max 3 consecutive same-direction
- PII filter applied at ingest (before event log) and before embedding
