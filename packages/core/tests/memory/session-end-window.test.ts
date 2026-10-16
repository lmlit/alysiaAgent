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

  // ★ 2026-10-16（change: `fix-summary-anchor-floor`，KI-26）**刻意修订**：
  //
  //   本条原来断言「无历史摘要 → 回退 24h：25h 前的不进」。那个断言是在
  //   2026-10-11 事故之后写的，目的是「**不要重摘全历史**」——但它的前提自相矛盾：
  //   标题写的是「**无**历史摘要」，那就**没有任何已摘过的内容可以被"重"摘**；
  //   把 25h 前那条排除掉不是防重复，而是**纯粹的丢失**（而且永久：
  //   下一次锚点会变成新摘要的 `ended_at`，那条就再也够不着了）。
  //
  //   新契约：**从未摘要过 ⇒ 从头摘**，但**有 7 天上限**（`COLD_START_LOOKBACK_MS`）。
  //   事故形态（46~61 天 / 1000 条）仍被上限挡住，上限咬到时会 warn ——
  //   见 `summary-anchor-floor.test.ts` 的「上限咬到」用例。守卫本身没丢，只是收紧了适用面。
  it('★ 无历史摘要 → **从头摘**（不再回退 24h，25h 前的也进）', async () => {
    const now = Date.now();
    await mm.ingest(msg('ancient', new Date(now - 25 * HOUR)));
    await mm.ingest(msg('recent', new Date(now - 1 * HOUR)));

    await mm.onSessionEnd(SID);

    const conv = latestConv(db);
    expect(conv.message_count).toBe(2);
    expect(conv.started_at).toBe(new Date(now - 25 * HOUR).toISOString());
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

  // ★ 2026-10-16 **刻意修订**（同上一条的理由）：cron 与 session-end 走**同一个** `summaryAnchor()`，
  //   所以「无历史摘要」在两条路径上必须表现一致 —— 都从头摘、都受 7 天上限约束。
  it('★ cron 路径：无历史摘要 → 同样从头摘（锚点规则只有一处）', async () => {
    const now = Date.now();
    await mm.ingest(msg('ancient', new Date(now - 30 * HOUR)));
    await mm.ingest(msg('recent', new Date(now - 2 * HOUR)));

    await mm.archiveStaleSessions();

    const conv = latestConv(db);
    expect(conv.message_count).toBe(2);
    expect(conv.started_at).toBe(new Date(now - 30 * HOUR).toISOString());
  });
});

// ─────────────────────────────────────────────────────────────
// ★ 2026-10-16 fix-summary-window-late-events
//
// cron 与「在途消息」是**两条独立时序**：cron 是同进程定时器，
// **不经过** dsh 适配器，所以适配器侧的串行化（fix-dsh-ingest-and-settlement）
// 管不到它。
//
// 丢失机制：窗口只有下界（`getBySession({since})`，无上界）；
// 若 `ended_at` 写墙钟 `now`，则**任何入库晚于其 `created_at` 的事件**
// 在下一次都会落在 `created_at >= anchor` 的窗口之外 —— **永远不被摘要**，
// 而那条摘要是 `summary_status='ok'`，`retryFailedSummaries()` 不会补。
//
// 本组测试守的是**窗口右边界**：它必须是**数据边界**，不是墙钟。
// ─────────────────────────────────────────────────────────────

describe('★ 摘要窗口右边界 — 迟到事件不得被越过（2026-10-16）', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    ({ db, mm } = makeMM());
  });

  afterEach(() => db.close());

  const allConvs = (db: Database.Database): any[] =>
    db.prepare('SELECT * FROM conversations WHERE session_id = ? ORDER BY ended_at ASC').all(SID);

  it('★★ 主症：cron 先摘要后，迟到事件仍必须被下一次摘要覆盖', async () => {
    const now = Date.now();
    // ① 会话已有 1 条**已落库**事件 ⇒ 它算「24h 内活跃」，cron 会处理它
    await mm.ingest(msg('landed-1', new Date(now - 30 * 60_000)));

    // ② cron 这一轮先跑（同进程定时器，不经过适配器）
    await mm.archiveStaleSessions();
    const first = latestConv(db);
    expect(first.message_count).toBe(1);
    expect(first.summary_status).toBe('ok');

    // ③ 在途的那条此刻才落库 —— `created_at` 取自**来源系统的事件时间**
    //    （dsh 侧就是 `event.time`），早于上一次摘要的处理时刻
    await mm.ingest(msg('late-1', new Date(now - 10 * 60_000)));

    // ④ 下一次结算必须把它摘进去
    await mm.onSessionEnd(SID);

    // 修复前：anchor = 上条 ended_at(≈now) > late-1.created_at(now-10min)
    //         ⇒ 窗口内 0 条 ⇒ `no-events` ⇒ 不落新行 ⇒ **永久丢失**
    const rows = allConvs(db);
    expect(rows.length, '迟到事件被摘要窗口越过了 —— 它永久进不了摘要').toBe(2);
    expect(rows[1].message_count).toBe(1);
  });

  it('★ ended_at 取**数据边界**（窗口内最新事件的时间），不是墙钟', async () => {
    const now = Date.now();
    const t = new Date(now - 30 * 60_000);
    await mm.ingest(msg('landed-1', t));

    await mm.onSessionEnd(SID);

    const conv = latestConv(db);
    expect(conv.ended_at, 'ended_at 写了墙钟 ⇒ 锚点会越过未入库的数据').toBe(t.toISOString());
  });

  it('★ 锚点单调不回退：窗口右边界必然是窗口内最新事件（≥ 下界）', async () => {
    const now = Date.now();
    seedPrevSummary(db, new Date(now - 1 * HOUR));
    const newest = new Date(now - 30 * 60_000);
    await mm.ingest(msg('fresh-1', newest));

    await mm.onSessionEnd(SID);

    const conv = latestConv(db);
    expect(conv.ended_at).toBe(newest.toISOString());
    // 窗口是 [anchor, …]，窗口内事件必然 >= anchor ⇒ 右边界不会退到下界之前
    expect(Date.parse(conv.ended_at)).toBeGreaterThanOrEqual(now - 1 * HOUR);
  });

  it('★ 来源时钟偏移（事件时间在未来）→ ended_at 仍不得晚于处理时刻', async () => {
    // 否则那条「未来」的 ended_at 会把 (now, 未来] 之间的事件全挡在窗口外 ⇒ 丢数据
    const now = Date.now();
    await mm.ingest(msg('future-1', new Date(now + 60 * 60_000)));

    await mm.onSessionEnd(SID);

    const conv = latestConv(db);
    expect(Date.parse(conv.ended_at)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('★ 幂等：同一批数据重跑摘要不会跳过任何东西', async () => {
    const now = Date.now();
    await mm.ingest(msg('m-1', new Date(now - 40 * 60_000)));
    await mm.ingest(msg('m-2', new Date(now - 20 * 60_000)));

    await mm.onSessionEnd(SID);
    await mm.onSessionEnd(SID);   // 再跑一次

    const conv = latestConv(db);
    // 第二次窗口为空（数据边界已推到最新事件）⇒ 不落新行，也不漏
    expect(conv.message_count).toBe(2);
    expect(conv.ended_at).toBe(new Date(now - 20 * 60_000).toISOString());
  });
});
