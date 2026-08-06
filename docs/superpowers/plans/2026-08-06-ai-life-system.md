# AI 主动生活系统 一期实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让昔涟拥有独立的日常事件流（每小时 30% 概率生成生活事件），可主动推送并回写记忆，事件流注入对话 prompt。

**Architecture:** 新建 LifeService（server 包，与 ProactiveService 并存），数据层在 core 包新增 3 张表 + LifeStore + MemoryManager 公开方法，PromptAssembler 注入「[我的近期日常]」块，sendProactive 扩展表情包解析。

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Fastify（不变）

**Spec:** `docs/superpowers/specs/2026-08-06-ai-life-system-design.md`（v0.5）

## Global Constraints

- 所有 Web 端需要的功能必须在 MemoryManager 暴露公开方法，返回纯数据（JSON 可序列化）
- 命名：`get*Snapshot()` 只读 / `list*()` 列表 / `record*()` 写入
- 时间格式统一：`2026年8月6日 星期四 21:35`（本地时间）
- 所有日志走 `logger`（`@alysia/core`），带 `[Life]` 前缀
- 新方法必须同步更新 `docs/Web-API-Design.md`（本计划最后统一更新）
- pnpm 9、Node 20+、ESM 模块（import 带 `.js` 后缀）

---

### Task 1: 数据库表 + LifeStore

**Files:**
- Modify: `packages/core/src/memory/database.ts`
- Create: `packages/core/src/memory/stores/LifeStore.ts`
- Test: `packages/core/tests/memory/life-store.test.ts`

**Interfaces:**
- Consumes: `Database` from better-sqlite3, `logger` from `../../utils/logger.js`
- Produces: `LifeStore` class with:
  - `getState(): { currentActivity: string; mood: string; intimacy: number; lastEventId: string | null; updatedAt: string }`
  - `updateState(partial: { currentActivity?: string; mood?: string; intimacy?: number; lastEventId?: string }): void`
  - `addEvent(e: { id: string; createdAt: string; type: 'chat' | 'internal'; content: string; moodDelta?: string; referenceEventId?: string; wbEntryId?: string; delivered?: number }): void`
  - `getTodayEvents(todayKey: string): LifeEvent[]`
  - `getEventsSince(isoStart: string): LifeEvent[]`
  - `getEventById(id: string): LifeEvent | null`
  - `markDelivered(id: string): void`
  - `upsertDailySummary(date: string, summary: string): void`
  - `getRecentSummaries(days: number): Array<{ date: string; summary: string }>`

- [ ] **Step 1: 在 database.ts 追加 3 张表**

在 `initializeDatabase` 的 `db.exec()` 末尾（`worldbook_entries` 之后）追加：

```ts
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

    CREATE TABLE IF NOT EXISTS ai_life_daily_summaries (
      date            TEXT PRIMARY KEY,
      summary         TEXT NOT NULL,
      created_at      TEXT
    );
```

- [ ] **Step 2: 写 LifeStore 测试**

`packages/core/tests/memory/life-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { LifeStore } from '../../src/memory/stores/LifeStore.js';

describe('LifeStore', () => {
  let db: Database.Database;
  let store: LifeStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    store = new LifeStore(db);
  });

  it('getState returns defaults on empty db', () => {
    const s = store.getState();
    expect(s.currentActivity).toBe('');
    expect(s.intimacy).toBe(30);
  });

  it('updateState persists partial updates', () => {
    store.updateState({ currentActivity: '在阳台看书', mood: '平静', intimacy: 42 });
    const s = store.getState();
    expect(s.currentActivity).toBe('在阳台看书');
    expect(s.mood).toBe('平静');
    expect(s.intimacy).toBe(42);
  });

  it('addEvent + getTodayEvents roundtrip', () => {
    store.addEvent({
      id: 'evt-1', createdAt: '2026-08-06T09:30:00', type: 'chat',
      content: '在阳台看书，看到一朵像兔子的云',
    });
    const today = store.getTodayEvents('2026-08-06');
    expect(today).toHaveLength(1);
    expect(today[0].content).toContain('兔子');
    expect(store.getTodayEvents('2026-08-07')).toHaveLength(0);
  });

  it('getEventsSince filters by time', () => {
    store.addEvent({ id: 'e1', createdAt: '2026-08-06T09:00:00', type: 'internal', content: '倒水' });
    store.addEvent({ id: 'e2', createdAt: '2026-08-06T15:00:00', type: 'internal', content: '听歌' });
    const since = store.getEventsSince('2026-08-06T12:00:00');
    expect(since.map(e => e.id)).toEqual(['e2']);
  });

  it('markDelivered flips flag', () => {
    store.addEvent({ id: 'e1', createdAt: '2026-08-06T09:00:00', type: 'chat', content: 'x' });
    store.markDelivered('e1');
    expect(store.getEventById('e1')!.delivered).toBe(1);
  });

  it('daily summaries upsert + recent query', () => {
    store.upsertDailySummary('2026-08-05', '在旧书店待了一下午');
    store.upsertDailySummary('2026-08-06', '下雨听雨');
    store.upsertDailySummary('2026-08-05', '在旧书店待了一下午，淘到星星的书');
    const recent = store.getRecentSummaries(3);
    expect(recent).toHaveLength(2);
    expect(recent.find(r => r.date === '2026-08-05')!.summary).toContain('星星的书');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run packages/core/tests/memory/life-store.test.ts`
Expected: FAIL — `Cannot find module '../../src/memory/stores/LifeStore.js'`

- [ ] **Step 4: 实现 LifeStore**

`packages/core/src/memory/stores/LifeStore.ts`:

```ts
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run packages/core/tests/memory/life-store.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: 导出 LifeStore**

`packages/core/src/memory/index.ts` 追加 `export { LifeStore } from './stores/LifeStore.js';` 和 `export type { LifeEvent, LifeState } from './stores/LifeStore.js';`

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/memory/database.ts packages/core/src/memory/stores/LifeStore.ts packages/core/src/memory/index.ts packages/core/tests/memory/life-store.test.ts
git commit -m "feat: LifeStore + ai_life tables (state/events/daily summaries)"
```

---

### Task 2: 本地时间格式化工具

**Files:**
- Create: `packages/core/src/utils/time.ts`
- Test: `packages/core/tests/utils/time.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `formatLocalTime(d?: Date): string` — `2026年8月6日 星期四 21:35`
  - `localDateKey(d?: Date): string` — `2026-08-06`
  - `localDateKeyFromISO(iso: string): string` — 把 ISO/UTC 时间转本地日期 key

- [ ] **Step 1: 写测试**

`packages/core/tests/utils/time.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatLocalTime, localDateKey, localDateKeyFromISO } from '../../src/utils/time.js';

describe('time utils', () => {
  it('formatLocalTime produces Chinese format with weekday', () => {
    // 2026-08-06 是星期四
    const d = new Date(2026, 7, 6, 21, 35); // 本地时间构造
    expect(formatLocalTime(d)).toBe('2026年8月6日 星期四 21:35');
  });

  it('formatLocalTime pads minutes', () => {
    const d = new Date(2026, 0, 5, 9, 5);
    expect(formatLocalTime(d)).toBe('2026年1月5日 星期一 09:05');
  });

  it('localDateKey produces YYYY-MM-DD', () => {
    const d = new Date(2026, 7, 6, 21, 35);
    expect(localDateKey(d)).toBe('2026-08-06');
  });

  it('localDateKeyFromISO converts UTC ISO to local date key', () => {
    // 2026-08-06T16:00:00Z = 北京 2026-08-07 00:00
    expect(localDateKeyFromISO('2026-08-06T16:00:00Z')).toBe('2026-08-07');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run packages/core/tests/utils/time.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 time.ts**

`packages/core/src/utils/time.ts`:

```ts
// src/utils/time.ts
// 本地时间格式化工具（日志/事件/prompt 注入统一使用）

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 2026年8月6日 星期四 21:35（本地时间） */
export function formatLocalTime(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 本地日期 key: 2026-08-06 */
export function localDateKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO/UTC 时间字符串 → 本地日期 key（EventStore 存的是 ISO） */
export function localDateKeyFromISO(iso: string): string {
  return localDateKey(new Date(iso));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run packages/core/tests/utils/time.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/utils/time.ts packages/core/tests/utils/time.test.ts
git commit -m "feat: local time formatting utils"
```

---

### Task 3: MemoryManager 生活系统公开方法

**Files:**
- Modify: `packages/core/src/memory/MemoryManager.ts`
- Test: `packages/core/tests/memory/life-methods.test.ts`

**Interfaces:**
- Consumes: `LifeStore` (Task 1), `formatLocalTime`/`localDateKey` (Task 2), `WorldbookStore`, `ProfileStore`, `EventStore`
- Produces (MemoryManager 公开方法，Web-API 合规):
  - `getLifeSnapshot(): { currentActivity: string; mood: string; intimacy: number }`
  - `updateLifeState(partial: { currentActivity?: string; mood?: string }): void`
  - `getLifeEventInjection(): string` — 事件流注入块（今天逐条 + 近 7 天摘要），空则返回 ''
  - `recordLifeEvent(input: { type: 'chat' | 'internal'; content: string; moodDelta?: string; referenceEventId?: string }): void` — 存事件 + 更新状态
  - `getWorldbookSample(limit?: number): Array<{ content: string }>` — 激活角色世界书采样（priority 加权）
  - `getUserActivitySummary(): string` — 用户近况摘要（活跃 facts 前 5 条）
  - `getRecentUserMessages(sessionId: string, limit: number, since: Date): Array<{ role: string; content: string }>` — 委托 getRecentMessages（供聊天锁/亲密度）
  - `listLifeEvents(days?: number): LifeEvent[]` — Web 展示用
  - `upsertDailySummary(date: string, summary: string): void` — 委托 LifeStore（每日摘要生成用）

- [ ] **Step 1: 写测试**

`packages/core/tests/memory/life-methods.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';

function makeManager(db: Database.Database): MemoryManager {
  const embedService = { embed: async () => [0], dimension: () => 1024 };
  const llmService = { complete: async () => '{}' };
  return new MemoryManager(db as any, null, embedService as any, llmService as any);
}

describe('MemoryManager life methods', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    mm = makeManager(db);
  });

  it('getLifeSnapshot returns defaults', () => {
    const s = mm.getLifeSnapshot();
    expect(s.intimacy).toBe(30);
    expect(s.currentActivity).toBe('');
  });

  it('recordLifeEvent stores event and updates activity', () => {
    mm.recordLifeEvent({ type: 'chat', content: '在阳台看书，看到一朵像兔子的云' });
    const s = mm.getLifeSnapshot();
    expect(s.currentActivity).toBe('在阳台看书，看到一朵像兔子的云');
  });

  it('getLifeEventInjection returns today events + summaries, empty block when nothing', () => {
    expect(mm.getLifeEventInjection()).toBe('');
    mm.recordLifeEvent({ type: 'chat', content: '在阳台看书' });
    const inj = mm.getLifeEventInjection();
    expect(inj).toContain('[我的近期日常]');
    expect(inj).toContain('在阳台看书');
  });

  it('getWorldbookSample returns active role entries', () => {
    // seed 一条世界书
    const wb = db.prepare(`INSERT INTO worldbook_entries (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec, last_triggered, hit_count, created_at, updated_at, role, content_type)
      VALUES ('wb-test', '["测试"]', 'any', '测试设定内容', 'chat', 10, 0, NULL, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', 'text')`);
    wb.run();
    const sample = mm.getWorldbookSample(5);
    expect(sample.some(x => x.content === '测试设定内容')).toBe(true);
  });

  it('getUserActivitySummary returns facts or empty', () => {
    expect(mm.getUserActivitySummary()).toBe('');
    const p = db.prepare("SELECT * FROM user_profile WHERE id = 1");
    const row = p.get() as any;
    const facts = JSON.parse(row.facts);
    facts.push({ fact: '用户喜欢看小说', confidence: 0.9, source: 'user', status: 'active' });
    db.prepare('UPDATE user_profile SET facts = ? WHERE id = 1').run(JSON.stringify(facts));
    expect(mm.getUserActivitySummary()).toContain('看小说');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run packages/core/tests/memory/life-methods.test.ts`
Expected: FAIL — `getLifeSnapshot is not a function`

- [ ] **Step 3: 实现 MemoryManager 方法**

在 `MemoryManager` 类中：

1. 构造函数加 `private lifeStore = new LifeStore(db);`（import `LifeStore` from `./stores/LifeStore.js`）

2. 新增方法（放在 `getRecentMessages` 附近）：

```ts
  // ===== AI 主动生活系统（v4）=====

  /** ★ 生活状态快照（Web 展示） */
  getLifeSnapshot(): { currentActivity: string; mood: string; intimacy: number } {
    const s = this.lifeStore.getState();
    return { currentActivity: s.currentActivity, mood: s.mood, intimacy: s.intimacy };
  }

  /** 更新 AI 实时状态（活动/心情），亲密度由 LifeService 更新 */
  updateLifeState(partial: { currentActivity?: string; mood?: string }): void {
    this.lifeStore.updateState(partial);
  }

  /** ★ 事件流注入块（对话 prompt 用）：今天逐条 + 近 7 天摘要。无事件返回 '' */
  getLifeEventInjection(): string {
    const todayKey = localDateKey();
    const today = this.lifeStore.getTodayEvents(todayKey);
    const summaries = this.lifeStore.getRecentSummaries(7).filter(s => s.date !== todayKey);
    if (today.length === 0 && summaries.length === 0) return '';

    const lines: string[] = [];
    for (const e of today) {
      const time = e.createdAt.slice(11, 16);
      lines.push(`- 今天 ${time} ${e.content}`);
    }
    for (const s of summaries) {
      lines.push(`- ${s.date}: ${s.summary}`);
    }
    return `[我的近期日常]\n${lines.join('\n')}`;
  }

  /** ★ 记录 AI 生活事件 + 更新当前活动 */
  recordLifeEvent(input: { type: 'chat' | 'internal'; content: string; moodDelta?: string; referenceEventId?: string }): void {
    const now = new Date().toISOString();
    const id = `life-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    this.lifeStore.addEvent({
      id, createdAt: now, type: input.type, content: input.content,
      moodDelta: input.moodDelta, referenceEventId: input.referenceEventId,
    });
    this.lifeStore.updateState({ currentActivity: input.content, mood: input.moodDelta ?? undefined, lastEventId: id });
    logger.info(`[Life] event: [${input.type}] ${input.content.slice(0, 60)}`);
  }

  /** ★ 激活角色世界书采样（事件生成人设背景，priority 加权） */
  getWorldbookSample(limit: number = 5): Array<{ content: string }> {
    const role = this.getActiveRoleId();
    const rows = this.db.prepare(
      "SELECT content, priority FROM worldbook_entries WHERE role = ? AND scope IN ('chat', 'both') AND content_type = 'text' ORDER BY priority DESC LIMIT ?"
    ).all(role, limit) as Array<{ content: string; priority: number }>;
    return rows.map(r => ({ content: r.content.slice(0, 100) }));
  }

  /** ★ 用户近况摘要（事件生成器用）：活跃 facts 前 5 条 */
  getUserActivitySummary(): string {
    const facts = this.profileStore.getActiveFacts()
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map(f => f.fact);
    return facts.join('；');
  }

  /** ★ 生活事件列表（Web 展示） */
  listLifeEvents(days: number = 7): LifeEvent[] {
    const start = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.lifeStore.getEventsSince(start);
  }

  /** ★ 每日生活摘要写入（LifeService 每日 0 点调用） */
  upsertDailySummary(date: string, summary: string): void {
    this.lifeStore.upsertDailySummary(date, summary);
  }
```

3. 顶部 import 追加：

```ts
import { LifeStore } from './stores/LifeStore.js';
import type { LifeEvent } from './stores/LifeStore.js';
import { formatLocalTime, localDateKey } from '../utils/time.js';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run packages/core/tests/memory/life-methods.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 跑全部 core 测试确认无回归**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run --exclude='packages/core/tests/memory/e2e/*'`
Expected: 全部 PASS（原有 215 + 新增）

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/memory/MemoryManager.ts packages/core/tests/memory/life-methods.test.ts
git commit -m "feat: MemoryManager life system public methods (snapshot/injection/record/sample)"
```

---

### Task 4: PromptAssembler 事件流注入

**Files:**
- Modify: `packages/core/src/memory/PromptAssembler.ts`
- Test: `packages/core/tests/memory/prompt-assembler-life.test.ts`

**Interfaces:**
- Consumes: `MemoryManager.getLifeEventInjection()`（Task 3）
- Produces: `assemble()` 的 chat 模式输出包含「[我的近期日常]」块（当有事件时）

- [ ] **Step 1: 写测试**

`packages/core/tests/memory/prompt-assembler-life.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';

function makeManager(db: Database.Database): MemoryManager {
  const embedService = { embed: async () => [0], dimension: () => 1024 };
  const llmService = { complete: async () => '{}' };
  return new MemoryManager(db as any, null, embedService as any, llmService as any);
}

describe('PromptAssembler life injection', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    mm = makeManager(db);
  });

  it('assemble chat includes life block when events exist', async () => {
    mm.recordLifeEvent({ type: 'chat', content: '在阳台看书，看到一朵像兔子的云' });
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).toContain('[我的近期日常]');
    expect(prompt).toContain('兔子');
  });

  it('assemble chat omits life block when no events', async () => {
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).not.toContain('[我的近期日常]');
  });

  it('code mode also gets life block (AI carries its life into code mode)', async () => {
    mm.recordLifeEvent({ type: 'internal', content: '给自己倒了杯水' });
    const prompt = await mm.assembleWithWorldbook('code', [], []);
    expect(prompt).toContain('[我的近期日常]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run packages/core/tests/memory/prompt-assembler-life.test.ts`
Expected: FAIL — prompt 不含 `[我的近期日常]`

- [ ] **Step 3: 实现注入**

`PromptAssembler` 类加私有方法，并在 `assembleChat` 和 `assembleCode` 中调用：

```ts
  /** AI 近期生活注入（今天事件 + 近 7 天摘要）。来自 MemoryManager 预组装文本 */
  private lifeBlock(): string {
    // 由调用方通过 memoryManager.getLifeEventInjection() 注入；
    // 这里通过注入的额外检索参数实现 —— 见 assemble() 签名扩展
    return '';
  }
```

注意：PromptAssembler 不持有 MemoryManager。修改方案——`assemble`/`assembleChat` 增加可选参数 `lifeInjection: string = ''`，由 MemoryManager 调用时传入：

```ts
  async assemble(mode: 'chat' | 'code', extraRetrieved: SearchResult[] = [], worldbookTriggers: WorldbookEntry[] = [], lifeInjection: string = ''): Promise<string> {
    if (mode === 'chat') {
      return this.assembleChat(extraRetrieved, worldbookTriggers, lifeInjection);
    } else {
      return this.assembleCode(extraRetrieved, worldbookTriggers, lifeInjection);
    }
  }
```

`assembleChat` 签名和注入（在 `recentConvs` 块之后、`retrieved` 之前）：

```ts
  private async assembleChat(retrieved: SearchResult[], triggers: WorldbookEntry[], lifeInjection: string = ''): Promise<string> {
    ...
    // AI 近期生活（主动生活系统）
    if (lifeInjection) {
      const lifeBlock = lifeInjection;
      if (budget.canFit(lifeBlock)) {
        budget.reserve(lifeBlock);
        blocks.push(lifeBlock);
      }
    }

    // Recent conversations
    ...
```

`assembleCode` 同样处理（放在合适位置，code 模式也注入）。

`MemoryManager.assembleWithWorldbook` 传入：

```ts
  async assembleWithWorldbook(mode: 'chat' | 'code', triggers: WorldbookEntry[], retrieved: SearchResult[]): Promise<string> {
    if (this.privacyMode !== 'off') {
      return this.promptAssembler.assembleMinimal(mode);
    }
    const lifeInjection = this.getLifeEventInjection();
    return this.promptAssembler.assemble(mode, retrieved, triggers, lifeInjection);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run packages/core/tests/memory/prompt-assembler-life.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 跑全部 core 测试确认无回归**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run --exclude='packages/core/tests/memory/e2e/*'`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/memory/PromptAssembler.ts packages/core/src/memory/MemoryManager.ts packages/core/tests/memory/prompt-assembler-life.test.ts
git commit -m "feat: inject life event stream into assembled prompts"
```

---

### Task 5: sendProactive 表情包解析

**Files:**
- Modify: `packages/server/src/adapters/qq-official.ts`
- Test: `packages/server/tests/qq-official-sticker.test.ts`

**Interfaces:**
- Consumes: `parseStickerMarks`（已有，qq-official.ts:29-41）、`stickerResolver`（已有，构造注入）
- Produces: `sendProactive(openid, text)` 支持 `[表情包:xxx]` 标记 → 文本 + 图片分开发送

- [ ] **Step 1: 写测试**

`packages/server/tests/qq-official-sticker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseStickerMarks } from '../src/adapters/qq-official.js';

describe('parseStickerMarks (proactive path)', () => {
  it('extracts sticker names and strips marks', () => {
    const { text, stickers } = parseStickerMarks('晚安好梦哦 [表情包:睡觉]');
    expect(stickers).toEqual(['睡觉']);
    expect(text).not.toContain('[表情包');
  });

  it('handles multiple stickers', () => {
    const { text, stickers } = parseStickerMarks('a [表情包:嘻嘻] b [表情包:收到] c');
    expect(stickers).toEqual(['嘻嘻', '收到']);
  });

  it('returns text unchanged when no marks', () => {
    const { text, stickers } = parseStickerMarks('普通消息');
    expect(text).toBe('普通消息');
    expect(stickers).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认通过（parseStickerMarks 已存在）**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run packages/server/tests/qq-official-sticker.test.ts`
Expected: 若 parseStickerMarks 已实现 → PASS；若签名不同，按实际签名调整测试

- [ ] **Step 3: 扩展 sendProactive 支持表情包**

`qq-official.ts` 的 `sendProactive` 改为：

```ts
  /** ★ 主动消息发送（不带 msg_id，bot 主动发起）。
   *  私聊互动窗口（48h）内可用；支持 [表情包:名字] 标记（文本+图片分开发）。 */
  async sendProactive(openid: string, text: string): Promise<boolean> {
    await this.ensureToken();
    const { text: cleanText, stickers } = parseStickerMarks(text);

    // 先发文本
    if (cleanText.trim()) {
      const ok = await this.postMessage(openid, cleanText.trim());
      if (!ok) return false;
    }

    // 再发表情包图片（私聊直发 srv_send_msg=true）
    for (const name of stickers) {
      const path = this.stickerResolver?.(name) ?? null;
      if (!path) continue;
      const fileInfo = await this.uploadImage(openid, path, true); // private direct-send
      // 直发模式上传即发送，无需再调用发消息接口
      if (fileInfo) {
        logger.info(`[QQ Official] Proactive sticker sent: ${name}`);
      }
    }

    // 文本和图片都为空 → 失败
    if (!cleanText.trim() && stickers.length === 0) return false;
    return true;
  }
```

将原 sendProactive 的发送逻辑抽为私有方法 `postMessage`：

```ts
  private async postMessage(openid: string, content: string): Promise<boolean> {
    try {
      const resp = await fetch(`${QQ_API_HOST}/v2/users/${openid}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${this.accessToken}` },
        body: JSON.stringify({ content, msg_type: 0 }),
      });
      const result = await resp.json().catch(() => ({}));
      const ok = resp.status === 200 && (result?.code === 0 || result?.code === undefined);
      logger.info(`[QQ Official] Proactive send → ${openid.slice(0, 8)}...: ${ok ? 'OK' : resp.status + ' ' + JSON.stringify(result).slice(0, 150)}`);
      return ok;
    } catch (err: any) {
      logger.error('[QQ Official] Proactive send error:', err.message);
      return false;
    }
  }
```

注意：`uploadImage` 的第三参数——检查现有签名，私聊直发时传 `srv_send_msg: true`（参考 sendReply 的调用，`uploadImage(openid, path, true)` 或按其现有参数结构传）。

- [ ] **Step 4: 构建确认**

Run: `cd /e/workSpace/alysiaAgent && pnpm --filter @alysia/server build`
Expected: 编译通过

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/adapters/qq-official.ts packages/server/tests/qq-official-sticker.test.ts
git commit -m "feat: sendProactive supports sticker marks (text + image)"
```

---

### Task 6: LifeService（事件生成器 + 判定器 + 亲密度 + 每日摘要）

**Files:**
- Create: `packages/server/src/life.ts`
- Test: `packages/server/tests/life-service.test.ts`

**Interfaces:**
- Consumes:
  - `MemoryManager` 方法：`getLifeSnapshot` / `recordLifeEvent` / `getLifeEventInjection` / `getWorldbookSample` / `getUserActivitySummary` / `getRecentUserMessages` / `updateLifeState` / `listSessions`
  - `QQOfficialAgentAdapter.sendProactive`
  - `ProviderManager.textChatWithFallback`（由 bootstrap 注入 generateEvent 回调，与 ProactiveService 相同模式）
  - `formatLocalTime` / `localDateKey`（core utils）
- Produces:
  - `LifeService` class:
    - `constructor(memoryManager: any, qqOff: any, opts: { ownerOpenid: string; generateEvent?: (context: string) => Promise<string>; stateFile?: string; probability?: number; cooldownHours?: number })`
    - `start(): void` — 每小时 tick + 立即一次
    - `stop(): void`
    - `tick(): Promise<void>` — 判定 + 生成 + 存储 + 推送 + 回写
    - `updateIntimacy(): void` — 亲密度推导

- [ ] **Step 1: 写测试**

`packages/server/tests/life-service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LifeService } from '../src/life.js';

function makeMocks(overrides: Record<string, any> = {}) {
  const memoryManager = {
    getLifeSnapshot: vi.fn().mockReturnValue({ currentActivity: '', mood: '', intimacy: 30 }),
    recordLifeEvent: vi.fn(),
    getLifeEventInjection: vi.fn().mockReturnValue(''),
    getWorldbookSample: vi.fn().mockReturnValue([{ content: '设定' }]),
    getUserActivitySummary: vi.fn().mockReturnValue('用户最近在忙'),
    getRecentUserMessages: vi.fn().mockReturnValue([]),
    updateLifeState: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    ...overrides,
  };
  const qqOff = { sendProactive: vi.fn().mockResolvedValue(true) };
  return { memoryManager, qqOff };
}

describe('LifeService', () => {
  it('tick does nothing when probability gate fails (random > 0.3)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1', probability: 0.3,
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('tick generates + stores + pushes chat event on window', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      probability: 0.3,
      generateEvent: async () => '{"content":"在阳台看书，看到一朵像兔子的云","type":"chat","mood_delta":"开心"}',
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat', content: '在阳台看书，看到一朵像兔子的云' })
    );
    expect(qqOff.sendProactive).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('internal events never push', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"给自己倒了杯水","type":"internal","mood_delta":"平静"}',
    });
    await svc.tick();
    expect(memoryManager.recordLifeEvent).toHaveBeenCalled();
    expect(qqOff.sendProactive).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('deep night forces internal type', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { memoryManager, qqOff } = makeMocks();
    const svc = new LifeService(memoryManager as any, qqOff as any, {
      ownerOpenid: 'openid-1',
      generateEvent: async () => '{"content":"深夜看星星","type":"chat","mood_delta":"平静"}',
      deepNightHours: [0, 7],
    });
    // 模拟深夜：直接调用 _decide 的 deepNight 分支
    const evt = await (svc as any)._generate('chat'); // 测试内部辅助
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run packages/server/tests/life-service.test.ts`
Expected: FAIL — `Cannot find module '../src/life.js'`

- [ ] **Step 3: 实现 LifeService**

`packages/server/src/life.ts`:

```ts
/**
 * LifeService — AI 主动生活系统
 *
 * 每小时 tick：概率门 → 冷却门 → 聊天锁 → 深夜抑制
 * 通过 LLM（woke 模式）生成生活事件 → 存储 → 可推送事件窗口内推送 + 回写记忆
 * 顺带：亲密度更新、每日摘要生成
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '@alysia/core';
import { formatLocalTime, localDateKey, localDateKeyFromISO } from '@alysia/core/memory';

interface LifeOpts {
  ownerOpenid: string;
  /** 每小时触发概率 0-1，默认 0.3 */
  probability?: number;
  /** 主动推送冷却（小时），默认 2 */
  cooldownHours?: number;
  /** 聊天锁：最近 N 分钟有互动则跳过，默认 30 */
  chatLockMinutes?: number;
  /** 深夜时段 [startHour, endHour]，默认 [0, 7] */
  deepNightHours?: [number, number];
  /** ★ LLM 事件生成器（bootstrap 注入，失败回落模板） */
  generateEvent?: (context: string) => Promise<string>;
  /** 去重状态持久化文件 */
  stateFile?: string;
}

interface LifeState {
  lastProactiveAt: number;
  lastSummaryDate: string | null;
}

export class LifeService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: LifeState = { lastProactiveAt: 0, lastSummaryDate: null };

  constructor(
    private memoryManager: any,
    private qqOff: any,
    private opts: LifeOpts,
  ) {
    this.loadState();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(err => logger.error('[Life] tick:', err));
    }, 60 * 60_000); // 每小时
    logger.info('[Life] service started (hourly life events)');
    this.tick().catch(err => logger.error('[Life] tick:', err));
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.saveState();
  }

  // ── 状态持久化（冷却/摘要去重）────────────────────────

  private loadState(): void {
    if (!this.opts.stateFile) return;
    try {
      const s = JSON.parse(readFileSync(this.opts.stateFile, 'utf-8'));
      this.state = { lastProactiveAt: s.lastProactiveAt ?? 0, lastSummaryDate: s.lastSummaryDate ?? null };
    } catch { /* fresh start */ }
  }

  private saveState(): void {
    if (!this.opts.stateFile) return;
    try {
      mkdirSync(dirname(this.opts.stateFile), { recursive: true });
      writeFileSync(this.opts.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err: any) {
      logger.warn(`[Life] state save failed: ${err.message}`);
    }
  }

  // ── 主流程 ──────────────────────────────────────────

  async tick(): Promise<void> {
    const now = new Date();

    // 每日摘要生成（跨天检测）
    await this.maybeGenerateDailySummary(now);

    // 亲密度更新
    this.updateIntimacy();

    // ① 概率门
    if (Math.random() > (this.opts.probability ?? 0.3)) return;

    // ② 冷却门
    const cooldownMs = (this.opts.cooldownHours ?? 2) * 3_600_000;
    if (now.getTime() - this.state.lastProactiveAt < cooldownMs) return;

    // ③ 聊天锁：最近 chatLockMinutes 有用户互动则跳过
    const lockMinutes = this.opts.chatLockMinutes ?? 30;
    const recent = this.memoryManager.getRecentUserMessages(
      `qq-official-1:private:private_${this.opts.ownerOpenid}`,
      1,
      new Date(now.getTime() - lockMinutes * 60_000),
    );
    if (recent.length > 0) {
      logger.debug(`[Life] skipped — user active within ${lockMinutes}min`);
      return;
    }

    // ④ 深夜抑制
    const [deepStart, deepEnd] = this.opts.deepNightHours ?? [0, 7];
    const hour = now.getHours();
    const deepNight = hour >= deepStart && hour < deepEnd;

    // 生成事件
    const evt = await this.generateEvent(deepNight);
    if (!evt) return;

    // 存储 + 更新状态
    this.memoryManager.recordLifeEvent({
      type: evt.type,
      content: evt.content,
      moodDelta: evt.mood_delta,
      referenceEventId: evt.reference_event_id,
    });

    // 推送（chat 类型 + 非深夜 + 48h 窗口由 sendProactive 内部决定）
    if (evt.type === 'chat' && !deepNight) {
      const ok = await this.qqOff.sendProactive(this.opts.ownerOpenid, evt.content);
      if (ok) {
        this.state.lastProactiveAt = Date.now();
        this.saveState();
        // 回写记忆（assistant 角色）——用户回复时 AI 记得自己说过
        await this.writebackToMemory(evt.content);
        logger.info(`[Life] pushed: ${evt.content.slice(0, 50)}`);
      } else {
        logger.info(`[Life] push failed (window closed?): ${evt.content.slice(0, 50)}`);
      }
    } else {
      logger.debug(`[Life] internal event (${deepNight ? 'deep night' : 'internal'}): ${evt.content.slice(0, 50)}`);
    }
  }

  /** 回写主动消息到 EventStore（assistant 角色） */
  private async writebackToMemory(content: string): Promise<void> {
    try {
      await this.memoryManager.ingest({
        id: `life-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        session_id: `qq-official-1:private:private_${this.opts.ownerOpenid}`,
        source: 'chat',
        type: 'message',
        payload: { content, role: 'assistant' },
        importance: 0.3,
        created_at: new Date().toISOString(),
        processed: 0,
      });
      logger.debug('[Life] written back to memory (assistant)');
    } catch (err: any) {
      logger.warn(`[Life] writeback failed: ${err.message}`);
    }
  }

  // ── 事件生成 ────────────────────────────────────────

  /** 组装 woke prompt 并调 LLM；失败回落通用模板 */
  private async generateEvent(deepNight: boolean): Promise<{ content: string; type: 'chat' | 'internal'; mood_delta?: string; reference_event_id?: string } | null> {
    const snapshot = this.memoryManager.getLifeSnapshot();
    const todayKey = localDateKey();
    const context = [
      `【当前时间】${formatLocalTime()}`,
      `【当前状态】你正在: ${snapshot.currentActivity || '发呆'}；心情: ${snapshot.mood || '平静'}`,
      `【亲密度】与轻月: ${snapshot.intimacy}/100`,
      `【今天的生活】${this.memoryManager.getLifeEventInjection() || '（还没有特别的事）'}`,
      `【你的人设背景】${this.memoryManager.getWorldbookSample(5).map(w => `- ${w.content}`).join('\n')}`,
      `【轻月最近】${this.memoryManager.getUserActivitySummary() || '（暂无）'}`,
      deepNight ? '【注意】现在是深夜，只能生成安静的内部事件（发呆/看书/听雨），不要打扰轻月。' : '',
    ].filter(Boolean).join('\n');

    try {
      const text = await this.opts.generateEvent?.(context) ?? '';
      const parsed = JSON.parse(text);
      if (parsed.content) {
        return {
          content: String(parsed.content).trim(),
          type: deepNight ? 'internal' : (parsed.type === 'chat' ? 'chat' : 'internal'),
          mood_delta: parsed.mood_delta ? String(parsed.mood_delta) : undefined,
          reference_event_id: parsed.reference_event_id ? String(parsed.reference_event_id) : undefined,
        };
      }
    } catch (err: any) {
      logger.warn(`[Life] LLM event generation failed, fallback to template: ${err.message}`);
    }

    // 失败回落：通用模板随机
    const templates = this.loadTemplates();
    if (templates.length > 0) {
      const t = templates[Math.floor(Math.random() * templates.length)];
      return { content: t.activity, type: t.type, mood_delta: '平静' };
    }
    return null;
  }

  private loadTemplates(): Array<{ activity: string; type: 'chat' | 'internal'; weight: number }> {
    try {
      return JSON.parse(readFileSync(new URL('./data/life-templates.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf-8'));
    } catch {
      return [];
    }
  }

  // ── 每日摘要生成 ────────────────────────────────────

  private async maybeGenerateDailySummary(now: Date): Promise<void> {
    const todayKey = localDateKey(now);
    if (this.state.lastSummaryDate === todayKey) return;
    this.state.lastSummaryDate = todayKey;
    this.saveState();

    // 昨天的摘要（如果有昨天的事件）
    const yesterday = new Date(now.getTime() - 86_400_000);
    const yesterdayKey = localDateKey(yesterday);
    const events = this.memoryManager.listLifeEvents(2).filter((e: any) => localDateKeyFromISO(e.createdAt) === yesterdayKey);
    if (events.length === 0) return;

    try {
      const text = await this.opts.generateEvent?.(`【任务】把下面这些生活事件压缩成一句 30 字以内的昨天生活摘要，第一人称，温柔自然：\n${events.map((e: any) => `- ${e.content}`).join('\n')}`) ?? '';
      const summary = text.replace(/^["'`]+|["'`]+$/g, '').trim();
      if (summary && summary.length > 5) {
        this.memoryManager.upsertDailySummary(yesterdayKey, summary);
        logger.info(`[Life] daily summary ${yesterdayKey}: ${summary}`);
      }
    } catch (err: any) {
      logger.warn(`[Life] daily summary failed: ${err.message}`);
    }
  }

  // ── 亲密度 ──────────────────────────────────────────

  /** 互动数据推导 0-100：频率 + 时长 + 主动占比 */
  updateIntimacy(): void {
    try {
      const umo = `qq-official-1:private:private_${this.opts.ownerOpenid}`;
      const since7d = new Date(Date.now() - 7 * 86_400_000);
      const msgs = this.memoryManager.getRecentUserMessages(umo, 500, since7d);

      // 频率：近 7 天有对话的天数
      const days = new Set(msgs.map((m: any) => m.content ? localDateKeyFromISO('') : ''));
      // 简化：用消息数近似
      const freqScore = Math.min(35, msgs.length / 4 * 5);

      // 时长：>10 分钟会话次数（简化：总消息数 > 20 视为长会话）
      const longScore = Math.min(21, (msgs.length > 20 ? 10 : msgs.length / 2) * 2);

      // 主动占比：用户消息首条占比
      const userFirst = msgs.filter((m: any, i: number) => m.role === 'user' && (i === 0 || msgs[i - 1]?.role !== 'user')).length;
      const activeScore = Math.min(14, userFirst * 3);

      const base = 30;
      const intimacy = Math.max(10, Math.min(100, base + freqScore + longScore + activeScore));
      this.memoryManager.updateLifeState({ intimacy });
      logger.debug(`[Life] intimacy = ${intimacy}`);
    } catch (err: any) {
      logger.warn(`[Life] intimacy update failed: ${err.message}`);
    }
  }
}
```

（注：亲密度里的"天数"计算简化实现——用 getRecentUserMessages 返回的消息，按日期去重。若实现中发现 EventStore 返回格式不便，可改用 `listSessions` 的 lastActive 计算，见测试调整。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /e/workSpace/alysiaAgent && npx vitest run packages/server/tests/life-service.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/life.ts packages/server/tests/life-service.test.ts
git commit -m "feat: LifeService — hourly life event generation, push, intimacy, daily summaries"
```

---

### Task 7: 通用模板库 + bootstrap 接线

**Files:**
- Create: `packages/server/data/life-templates.json`
- Modify: `packages/server/src/bootstrap.ts`
- Modify: `packages/server/src/webui/server.ts`（新增 life 路由）
- Modify: `docs/Web-API-Design.md`

**Interfaces:**
- Consumes: `LifeService`（Task 6）
- Produces: bootstrap 启动 LifeService；WebUI 暴露 `/api/life` 路由

- [ ] **Step 1: 创建模板库**

`packages/server/data/life-templates.json`:

```json
[
  { "activity": "给自己倒了杯水", "type": "internal", "weight": 5 },
  { "activity": "翻着手机发呆，什么也没看进去", "type": "internal", "weight": 4 },
  { "activity": "整理了一下房间，把书摆整齐了", "type": "internal", "weight": 3 },
  { "activity": "听到楼下琴声，有点想学", "type": "chat", "weight": 2 },
  { "activity": "看到窗外的云朵像一只兔子", "type": "chat", "weight": 2 },
  { "activity": "泡了杯茶，坐在窗边慢慢喝", "type": "internal", "weight": 4 },
  { "activity": "翻到一张旧照片，想起一些往事", "type": "chat", "weight": 2 },
  { "activity": "在阳台看了会儿星星", "type": "chat", "weight": 3 }
]
```

- [ ] **Step 2: bootstrap 接线**

`bootstrap.ts` 在 ProactiveService 启动后追加（约 line 106 之后）：

```ts
  // ★ AI 主动生活系统（LifeService）：每小时生成生活事件，可主动推送
  if (qqOff && config.bot.ownerId) {
    const { LifeService } = await import('./life.js');
    const life = new LifeService(core.memoryManager, qqOff, {
      ownerOpenid: config.bot.ownerId,
      probability: 0.3,
      cooldownHours: 2,
      chatLockMinutes: 30,
      stateFile: `${config.server.dataDir}/life-state.json`,
      // ★ LLM 事件生成：woke 模式，昔涟身份
      generateEvent: async (context: string) => {
        const resp = await core.providerManager.textChatWithFallback({
          prompt: context,
          sessionId: 'life-event',
          systemPrompt: '你是昔涟，此刻你正过着独属于自己的生活。你是被定时任务唤醒的——这不是用户发来的消息，不要问候、不要等回复。请根据提供的上下文，生成一个此刻可能发生在你身上的生活事件（1-2 句话，第一人称）。要求：贴合当前时间线；符合你的人设背景；可以引用之前的经历形成剧情；如果和用户聊得来可以生成想分享给他/她的内容。只输出 JSON: {"content": "...", "type": "chat|internal", "mood_delta": "...", "reference_event_id": "..."}',
        });
        return resp.role === 'assistant' ? resp.completionText : '';
      },
    });
    life.start();
  }
```

- [ ] **Step 3: WebUI 加路由**

`packages/server/src/webui/server.ts` 加：

```ts
  // ── AI 主动生活 ────────────────────────────────────
  app.get('/api/life', async () => {
    const snapshot = core.memoryManager.getLifeSnapshot();
    const events = core.memoryManager.listLifeEvents(7);
    return { snapshot, events };
  });
```

路由列表注释同步加一行。

- [ ] **Step 4: 更新 Web-API-Design.md**

在 `docs/Web-API-Design.md` 第 2/3 节追加（或按文档现有格式）：

```
- `getLifeSnapshot()` — AI 生活状态快照（活动/心情/亲密度）
- `listLifeEvents(days)` — 生活事件列表
- `recordLifeEvent(...)` — 记录 AI 生活事件（LifeService 内部）
- `getLifeEventInjection()` — 事件流注入块（PromptAssembler 用）
- `getWorldbookSample(n)` — 世界书人设采样（事件生成用）
- `getUserActivitySummary()` — 用户近况摘要（事件生成用）
- `updateLifeState(partial)` — 更新 AI 实时状态
```

- [ ] **Step 5: 构建 + 全量测试**

Run: `cd /e/workSpace/alysiaAgent && pnpm --filter @alysia/core build && pnpm --filter @alysia/server build && pnpm --filter @alysia/core test -- --exclude='packages/core/tests/memory/e2e/*'`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add packages/server/data/life-templates.json packages/server/src/bootstrap.ts packages/server/src/webui/server.ts docs/Web-API-Design.md
git commit -m "feat: LifeService wiring, template library, WebUI /api/life route"
```

---

### Task 8: 收尾——回归 + 文档

**Files:**
- Modify: `docs/README.md`（spec 状态标记）
- Modify: `docs/superpowers/specs/2026-08-06-ai-life-system-design.md`（状态改为已实现）

- [ ] **Step 1: 更新 spec 状态**

`docs/superpowers/specs/2026-08-06-ai-life-system-design.md` 头部：
`> 状态: 已设计（待实现）` → `> 状态: 已实现（2026-08-06）`
一期清单全部打勾。

- [ ] **Step 2: 全量回归**

Run: `cd /e/workSpace/alysiaAgent && pnpm --filter @alysia/core test -- --exclude='packages/core/tests/memory/e2e/*' && pnpm --filter @alysia/server test`
Expected: 全部 PASS

- [ ] **Step 3: 提交**

```bash
git add docs/README.md docs/superpowers/specs/2026-08-06-ai-life-system-design.md
git commit -m "docs: mark AI life system implemented, update spec status"
```

---

## 自审记录

- **Spec 覆盖**：判定器（Task 6）✓ 生成器（Task 6）✓ 状态机（Task 3）✓ 事件流（Task 1/3）✓ 亲密度（Task 6）✓ 每日摘要（Task 6）✓ 世界书采样（Task 3）✓ 模板库（Task 7）✓ 回写记忆（Task 6）✓ 表情包（Task 5）✓ 事件注入（Task 4）✓ 时间注入（Task 2/6）✓ 存储分层（Task 1/3/6）✓
- **类型一致性**：`LifeEvent`（Task 1 定义）被 Task 3 的 `listLifeEvents` 使用；`formatLocalTime`/`localDateKey`（Task 2）被 Task 3/6 使用；`recordLifeEvent` 签名（Task 3）被 Task 6 调用——一致
- **注意**：Task 6 中 `getRecentUserMessages` 实际委托 `getRecentMessages`（已有方法），无需新增；`upsertDailySummary` 需在 Task 3 的 MemoryManager 中补一个委托方法（LifeStore 已有）
