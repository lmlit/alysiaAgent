// tests/memory/session-end-window.test.ts
// ★ 2026-10-11 fix-session-end-window
//
// 这组测试直接编码线上故障：`MemoryManager` 有三个 SessionEnd 入口，
// `archiveStaleSessions` 传了窗口锚点，`onSessionEnd` / `extractProfile` **没传**。
// 于是 `process(sessionId)` 落到 `EventStore.getBySession` 的缺省语义
// 「全历史 `ORDER BY created_at DESC LIMIT 1000`」——窗口不是「这段会话」而是「最近 1000 条」。
//
// 线上实测（2026-10-11）：202 条摘要里 **153 条（76%）窗口跨度 > 24h**，
// **29 条恰好 `message_count = 1000`、跨度 46~61 天**，同一段历史被反复摘要
// （45 秒内连摘三次），摘要槽稳定失败（8 天 10 次空响应 + 4 次 truncated）。
//
// 本文件守的是**窗口边界**，不是摘要内容——所以断言 `message_count` / `started_at`。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';
import type { MemoryEvent } from '../../src/memory/types.js';

const SID = 'sess-window';
const HOUR = 3_600_000;

/** 一次响应同时满足摘要解析与画像提取解析（两个消费者共用这一个客户端） */
const LLM_JSON = JSON.stringify({
  summary: '窗口内摘要',
  participants: ['user'],
  topics: [],
  key_decisions: [],
  character_perspective: '',
  important_moments: [],
  adjustments: [],
  facts: [],
  character_facts: [],
});

function makeMM() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const embedService = { embed: async () => [0.1], dimension: () => 1024 };
  const llmService = { complete: async () => LLM_JSON };
  const mm = new MemoryManager(db as any, null as any, embedService as any, llmService as any);
  return { db, mm };
}

const msg = (id: string, at: Date): MemoryEvent => ({
  id, session_id: SID, source: 'chat', type: 'message',
  payload: { role: 'user', content: `内容 ${id}` },
  importance: 0, created_at: at.toISOString(), processed: 0,
});

/** 直接插一条历史摘要行（本测试要精确控制 ended_at = 锚点） */
function seedPrevSummary(db: Database.Database, endedAt: Date): void {
  db.prepare(
    `INSERT INTO conversations
       (id, session_id, summary, participants, topics, key_decisions, message_count,
        started_at, ended_at, embedding_id, character_perspective, summary_status)
     VALUES ('prev-summary', ?, '上一条摘要', '[]', '[]', '[]', 5, ?, ?, NULL, 'ok', 'ok')`,
  ).run(SID, new Date(endedAt.getTime() - HOUR).toISOString(), endedAt.toISOString());
}

/** 最新一条会话行（= 本次 process 落的那条） */
function latestConv(db: Database.Database): any {
  return db.prepare(
    'SELECT * FROM conversations WHERE session_id = ? ORDER BY ended_at DESC LIMIT 1',
  ).get(SID);
}

describe('SessionEnd 窗口锚点 — onSessionEnd 不得重摘全历史', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    ({ db, mm } = makeMM());
  });

  afterEach(() => db.close());

  it('★★ 核心回归：锚点之前的事件【不得】进本次窗口', async () => {
    const now = Date.now();
    const anchor = new Date(now - 1 * HOUR);      // 上一条摘要结束于 1 小时前

    seedPrevSummary(db, anchor);
    // 锚点之前两条（应该被排除）、锚点之后一条（应该被摘）
    await mm.ingest(msg('old-1', new Date(now - 2 * HOUR)));
    await mm.ingest(msg('old-2', new Date(now - 90 * 60_000)));
    await mm.ingest(msg('fresh-1', new Date(now - 30 * 60_000)));

    await mm.onSessionEnd(SID);

    const conv = latestConv(db);
    // 修复前：不传 since → getBySession 返回全历史（这里 3 条），
    // 线上真实规模下就是 1000 条 / 47 天窗口。
    expect(conv.message_count).toBe(1);
    // started_at 必须是窗口内最早那条，而不是 8 月的老事件
    expect(conv.started_at).toBe(new Date(now - 30 * 60_000).toISOString());
    expect(conv.summary_status).toBe('ok');
  });

  it('无历史摘要 → 回退 24h：25h 前的不进、1h 前的进', async () => {
    const now = Date.now();
    await mm.ingest(msg('ancient', new Date(now - 25 * HOUR)));
    await mm.ingest(msg('recent', new Date(now - 1 * HOUR)));

    await mm.onSessionEnd(SID);

    const conv = latestConv(db);
    expect(conv.message_count).toBe(1);
    expect(conv.started_at).toBe(new Date(now - 1 * HOUR).toISOString());
  });

  it('窗口内一个事件都没有 → 不落摘要行（no-events 不算失败）', async () => {
    const now = Date.now();
    seedPrevSummary(db, new Date(now - 1 * HOUR));   // 锚点 = 1h 前
    await mm.ingest(msg('old-only', new Date(now - 5 * HOUR)));

    await mm.onSessionEnd(SID);

    // conversations 里只有 seed 的那一条 prev-summary，没有新行
    const n = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE session_id = ?').get(SID) as any;
    expect(n.n).toBe(1);
  });

  it('★ extractProfile（Web「提取画像」按钮）同样受锚点约束', async () => {
    const now = Date.now();
    seedPrevSummary(db, new Date(now - 1 * HOUR));
    await mm.ingest(msg('old-1', new Date(now - 3 * HOUR)));
    await mm.ingest(msg('fresh-1', new Date(now - 10 * 60_000)));

    await mm.extractProfile(SID);

    const conv = latestConv(db);
    expect(conv.message_count).toBe(1);
    expect(conv.started_at).toBe(new Date(now - 10 * 60_000).toISOString());
  });
});

describe('SessionEnd 窗口锚点 — archiveStaleSessions 行为不变（重构回归）', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    ({ db, mm } = makeMM());
  });

  afterEach(() => db.close());

  it('cron 路径：有历史摘要时只摘锚点之后的', async () => {
    const now = Date.now();
    seedPrevSummary(db, new Date(now - 1 * HOUR));
    await mm.ingest(msg('old-1', new Date(now - 4 * HOUR)));
    await mm.ingest(msg('fresh-1', new Date(now - 20 * 60_000)));

    await mm.archiveStaleSessions();

    const conv = latestConv(db);
    expect(conv.message_count).toBe(1);
    expect(conv.started_at).toBe(new Date(now - 20 * 60_000).toISOString());
  });

  it('cron 路径：无历史摘要 → 仍回退 24h（不是重摘全历史）', async () => {
    const now = Date.now();
    await mm.ingest(msg('ancient', new Date(now - 30 * HOUR)));
    await mm.ingest(msg('recent', new Date(now - 2 * HOUR)));

    await mm.archiveStaleSessions();

    const conv = latestConv(db);
    expect(conv.message_count).toBe(1);
    expect(conv.started_at).toBe(new Date(now - 2 * HOUR).toISOString());
  });
});
