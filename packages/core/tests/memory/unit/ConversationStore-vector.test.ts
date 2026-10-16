// tests/memory/unit/ConversationStore-vector.test.ts
// ★ 2026-10-16 change: fix-store-write-trace（KI-15 / KI-14）
//
// KI-15：`vectorStore` 为 null（或写入失败）时**静默跳过嵌入**，而摘要行照样是
//   `summary_status='ok'` —— 于是「摘要在、向量一条没有」与「都写好了」在日志上完全一样。
//   `SessionEndProcessor` 原先那句 `if (ok && this.vectorStore)` 就是最危险的一处。
//
// 契约：摘要与向量**分别**可判。四种结果：
//   stored / no-store（没有向量库）/ no-vector（本次没有向量可写）/ failed（写失败）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database.js';
import { ConversationStore } from '../../../src/memory/stores/ConversationStore.js';
import { SessionEndProcessor } from '../../../src/memory/processors/SessionEndProcessor.js';
import type { Conversation } from '../../../src/memory/types.js';
import type { IVectorStore } from '../../../src/memory/interfaces/IVectorStore.js';
import { logger } from '../../../src/utils/logger.js';

function makeConv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    session_id: 's1',
    summary: '摘要',
    participants: '[]',
    topics: '[]',
    key_decisions: '[]',
    message_count: 1,
    started_at: '2026-10-16T10:00:00.000Z',
    ended_at: '2026-10-16T10:10:00.000Z',
    embedding_id: null,
    character_perspective: '',
    summary_status: 'ok',
    ...over,
  } as Conversation;
}

const okStore = (): IVectorStore => ({
  insert: vi.fn(async () => {}),
  search: vi.fn(async () => []),
  delete: vi.fn(async () => {}),
  count: vi.fn(async () => 0),
});

describe('ConversationStore — 向量写入结果四态（KI-15）', () => {
  let db: Database.Database;

  beforeEach(() => { db = new Database(':memory:'); initializeDatabase(db); });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('★ 正常写入 → stored，且摘要行照样落库', async () => {
    const vs = okStore();
    const s = new ConversationStore(db, vs);

    await expect(s.insert(makeConv(), [0.1, 0.2])).resolves.toBe('stored');
    expect(vs.insert).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) n FROM conversations').get()).toEqual({ n: 1 });
  });

  it('★ 向量库为 null → **no-store**（不再无声跳过）', async () => {
    const s = new ConversationStore(db, null);

    await expect(s.insert(makeConv(), [0.1])).resolves.toBe('no-store');
    // 摘要行仍然要落 —— 没有向量库不该让摘要丢失
    expect(db.prepare('SELECT COUNT(*) n FROM conversations').get()).toEqual({ n: 1 });
  });

  it('★ 本次没有向量（上游嵌入失败就没给）→ no-vector', async () => {
    const vs = okStore();
    const s = new ConversationStore(db, vs);

    await expect(s.insert(makeConv(), undefined)).resolves.toBe('no-vector');
    expect(vs.insert).not.toHaveBeenCalled();
  });

  it('★★ 有库有向量但写入失败 → **failed**，且摘要行不丢、有 warn', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const vs: IVectorStore = { ...okStore(), insert: vi.fn(async () => { throw new Error('lancedb down'); }) };
    const s = new ConversationStore(db, vs);

    await expect(s.insert(makeConv(), [0.1])).resolves.toBe('failed');
    // 摘要行已经写好了，向量失败不该把它拖垮
    expect(db.prepare('SELECT COUNT(*) n FROM conversations').get()).toEqual({ n: 1 });
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/向量写入失败/);
  });

  it('补处理路径同样四态：stored / failed / no-vector / no-store', async () => {
    const s = new ConversationStore(db, okStore());
    await s.insert(makeConv(), [0.1]);

    const data = {
      summary: '新摘要', participants: '[]', topics: '[]', key_decisions: '[]', character_perspective: '',
    };
    // ★ KI-17：返回值是 `{ rows, vector }` —— rows 必须可判（0 行 = 目标行不存在）
    await expect(s.updateSummaryResult('c1', data, [0.2])).resolves.toEqual({ rows: 1, vector: 'stored' });

    const failing = new ConversationStore(db, {
      ...okStore(), insert: vi.fn(async () => { throw new Error('down'); }),
    });
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(failing.updateSummaryResult('c1', data, [0.3])).resolves.toEqual({ rows: 1, vector: 'failed' });
    await expect(failing.updateSummaryResult('c1', data, undefined)).resolves.toEqual({ rows: 1, vector: 'no-vector' });
    const noStore = new ConversationStore(db, null);
    await expect(noStore.updateSummaryResult('c1', data, [0.3])).resolves.toEqual({ rows: 1, vector: 'no-store' });
  });

  it('★★ 补处理命中不存在的行 → rows: 0（**不是成功**）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const s = new ConversationStore(db, okStore());

    const r = await s.updateSummaryResult('不存在的-id', {
      summary: 'x', participants: '[]', topics: '[]', key_decisions: '[]', character_perspective: '',
    });

    // 旧实现在这里照样让调用方打「补处理成功」+ return true（KI-17）
    expect(r.rows).toBe(0);
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/0 行|不存在/);
  });

  it('★ 摘要状态与向量状态互不冒充：写入失败不把 summary_status 改成 failed', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const s = new ConversationStore(db, {
      ...okStore(), insert: vi.fn(async () => { throw new Error('down'); }),
    });

    await s.insert(makeConv(), [0.1]);

    // summary_status 的语义是「**摘要**生成状态」（KI-17），不该被向量失败污染；
    // 向量失败由返回值 + warn 表达，两者是独立的两条账。
    const row = db.prepare('SELECT summary_status FROM conversations WHERE id = ?').get('c1') as any;
    expect(row.summary_status).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────
// 处理器层：`SessionEndResult.vectorOutcome` 必须如实反映四种状态
//
// ★ 这里要守的是 KI-15 点名「**最危险**」的那一处：
//   `SessionEndProcessor` 原先是 `if (ok && this.vectorStore)` ——
//   摘要成功但向量没写时，调用方只数 `summarized`，就会把
//   「摘要在、向量全没」报成 `archived N/M` 全绿（2026-09-27 回填事故同形）。
// ─────────────────────────────────────────────────────────────

describe('SessionEndProcessor — vectorOutcome 四态（KI-15）', () => {
  const ev = {
    id: 'e1', session_id: 's1', source: 'chat', type: 'message',
    payload: { content: '你好', role: 'user' }, importance: 0,
    created_at: '2026-10-16T10:00:00.000Z', processed: 0,
  };

  /** 造一个只关心「向量那本账」的处理器 */
  function proc(opts: {
    /** 摘要 store 的返回值（模拟 ConversationStore 的契约） */
    insertReturns?: string | undefined;
    vectorStore?: unknown;
    embedThrows?: boolean;
    llm?: string;
  }) {
    return new SessionEndProcessor(
      { getBySession: () => [ev], markProcessed: () => {}, updateImportance: () => {} } as any,
      { insert: async () => opts.insertReturns, updateSummaryResult: async () => 'stored' } as any,
      { addFacts: () => {}, addCharacterFacts: () => {} } as any,
      {} as any, {} as any,
      { extract: async () => ({ facts: [], characterFacts: [] }) } as any,
      { processSignal: async () => null, apply: () => {} } as any,
      { complete: async () => opts.llm ?? '{"summary":"正常摘要"}' } as any,
      { embed: async () => { if (opts.embedThrows) throw new Error('embed down'); return [0.1]; } } as any,
      opts.vectorStore === undefined ? null : (opts.vectorStore as any),
    );
  }

  it('★ 无向量库 → no-store（摘要成功也要如实说「向量没写」）', async () => {
    await expect(proc({ vectorStore: null }).process('s1'))
      .resolves.toMatchObject({ summarized: true, vectorOutcome: 'no-store' });
  });

  it('★ 有库且写入成功 → stored', async () => {
    await expect(proc({ vectorStore: okStore(), insertReturns: 'stored' }).process('s1'))
      .resolves.toMatchObject({ summarized: true, vectorOutcome: 'stored' });
  });

  it('★ 写入失败 → failed', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(proc({ vectorStore: okStore(), insertReturns: 'failed' }).process('s1'))
      .resolves.toMatchObject({ summarized: true, vectorOutcome: 'failed' });
  });

  it('★ 嵌入失败 → failed（不写向量，但摘要照样落）', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(proc({ vectorStore: okStore(), embedThrows: true }).process('s1'))
      .resolves.toMatchObject({ summarized: true, vectorOutcome: 'failed' });
  });

  it('★ store 没按契约返回 → 按 failed 记（宁可报坏，不让向量状态悄悄变空）', async () => {
    await expect(proc({ vectorStore: okStore(), insertReturns: undefined }).process('s1'))
      .resolves.toMatchObject({ vectorOutcome: 'failed' });
  });

  it('摘要失败 → 本就不该 embed，记 no-vector（不是 failed）', async () => {
    await expect(proc({ vectorStore: okStore(), insertReturns: 'no-vector', llm: '这不是 JSON' }).process('s1'))
      .resolves.toMatchObject({ summarized: false, reason: 'summary-failed', vectorOutcome: 'no-vector' });
  });
});
