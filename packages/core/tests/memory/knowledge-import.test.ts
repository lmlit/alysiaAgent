// tests/memory/knowledge-import.test.ts
// ★ 2026-10-16 change: fix-store-write-trace（KI-13）
//
// KI-13：知识库导入的经典「半截文档 + hash 去重锁死」——
//   ① `insert(doc)` 先落 doc 行（`chunk_count = chunks.length`、`status='active'`），
//      再**循环落 chunk**，两者**不在一个事务里**；
//   ② 中途失败 → 留下一个「完全正常的活跃文档」外壳：`status='active'`、
//      `chunk_count=N`，而实际只有前几个 chunk。**零日志、永不自愈**；
//   ③ 重试被 `getByHash` 命中那颗残行 → 返回**从未兑现的块数**并宣布「已导入 N 块」。
//
// ★ 用 SQLite 触发器制造**确定性**的「第 N 块写失败」——
//   比 mock 更接近真实失败（真在 INSERT 上炸），且可精确控制炸在哪一片。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';
import { logger } from '../../src/utils/logger.js';

/** 够长、且句子各不相同 —— 保证分块结果稳定且不止一块 */
const LONG_CONTENT = Array.from({ length: 400 }, (_, i) => `第${i}句关于记忆系统的知识内容。`).join('');

function makeMM() {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const embedService = { embed: async () => [0.1], dimension: () => 1024 };
  const llmService = { complete: async () => '{}' };
  // vectorStore = null：本文件只测 **SQLite 侧的原子性**（向量是另一条链路，已由 KI-15 覆盖）
  const mm = new MemoryManager(db as any, null as any, embedService as any, llmService as any);
  return { db, mm };
}

/** 让第 `index` 个 chunk 的 INSERT 直接 ABORT（模拟中途失败） */
function failChunkAt(db: Database.Database, index: number): void {
  db.exec(`CREATE TRIGGER boom_chunk BEFORE INSERT ON knowledge_chunks
           WHEN NEW.chunk_index = ${index}
           BEGIN SELECT RAISE(ABORT, 'boom-chunk-${index}'); END;`);
}
const clearTrigger = (db: Database.Database): void => { db.exec('DROP TRIGGER IF EXISTS boom_chunk'); };

const countDocs = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(*) n FROM knowledge_docs').get() as any).n;
const countChunks = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(*) n FROM knowledge_chunks').get() as any).n;

describe('KI-13 知识导入 — 中途失败不得留下"伪装完整"的文档', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => { ({ db, mm } = makeMM()); vi.restoreAllMocks(); });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('★★ 主症：第 2 块写失败 → 库里**不留任何** doc/chunk（旧实现留下 active + 虚高 chunk_count 的壳）', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    failChunkAt(db, 1);

    await expect(
      mm.importKnowledge({ title: '会被打断的知识', content: LONG_CONTENT }),
    ).rejects.toThrow(/boom-chunk-1/);

    // 旧实现：doc 行在（status='active'、chunk_count=总块数）+ 第 0 块在 ⇒ 看起来"完全正常"
    expect(countDocs(db), '留下了伪装完整的文档壳').toBe(0);
    expect(countChunks(db), '留下了半截 chunk').toBe(0);
  });

  it('★ 修好后重试能完成导入（触发器撤掉 → 全量落库，块数如实）', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    failChunkAt(db, 1);
    await expect(mm.importKnowledge({ title: 't', content: LONG_CONTENT })).rejects.toThrow();

    clearTrigger(db);
    const r = await mm.importKnowledge({ title: 't', content: LONG_CONTENT });

    expect(r.deduplicated).toBe(false);
    expect(r.chunks).toBeGreaterThan(1);
    expect(countDocs(db)).toBe(1);
    expect(countChunks(db), 'chunk 数必须等于声明的块数').toBe(r.chunks);

    const doc = mm['knowledgeStore'].getById(r.docId)!;
    expect(doc.chunk_count, 'chunk_count 必须用**实到块数**').toBe(r.chunks);
    expect(mm['knowledgeStore'].getChunksByDoc(r.docId).length).toBe(r.chunks);
  });
});

describe('KI-13 hash 去重 — 命中不等于完整', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => { ({ db, mm } = makeMM()); vi.restoreAllMocks(); });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('★★ 残行（chunk_count=99 但只有 1 个 chunk）→ **不许**宣布「已导入 99 块」', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const hash = (await import('node:crypto')).createHash('sha256')
      .update('残行文档' + LONG_CONTENT).digest('hex');

    // 手工造一颗"上次半途失败"的残行
    db.prepare(
      `INSERT INTO knowledge_docs (id, title, source, file_path, content_hash, chunk_count, status, created_at, updated_at)
       VALUES ('kb-broken', '残行文档', 'imported', NULL, ?, 99, 'active', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    ).run(hash);
    db.prepare(
      `INSERT INTO knowledge_chunks (id, doc_id, chunk_index, content, created_at)
       VALUES ('chunk_0', 'kb-broken', 0, '半截', '2026-10-01T00:00:00Z')`,
    ).run();

    const r = await mm.importKnowledge({ title: '残行文档', content: LONG_CONTENT });

    // 旧实现：`getByHash` 命中 → `{ chunks: 99, deduplicated: true }` —— 从未兑现的块数
    expect(r.chunks, '把从未兑现的 chunk_count 当成了事实').not.toBe(99);
    expect(r.deduplicated, '残行不该被当作"已导入过"').toBe(false);
    expect(countChunks(db)).toBe(r.chunks);
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/不完整|残/);
  });

  it('★ 真正完整的重复导入仍然是 deduplicated（不误伤去重）', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const first = await mm.importKnowledge({ title: 't2', content: LONG_CONTENT });
    const second = await mm.importKnowledge({ title: 't2', content: LONG_CONTENT });

    expect(second.deduplicated).toBe(true);
    expect(second.docId).toBe(first.docId);
    expect(second.chunks).toBe(first.chunks);
    expect(countDocs(db), '重复导入不该新增文档').toBe(1);
    expect(countChunks(db)).toBe(first.chunks);
  });

  it('★ 被归档的文档不算"已导入"（hash 命中但 status=archived → 重新导入）', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const first = await mm.importKnowledge({ title: 't3', content: LONG_CONTENT });
    mm.archiveKnowledgeDoc(first.docId);

    const again = await mm.importKnowledge({ title: 't3', content: LONG_CONTENT });

    expect(again.deduplicated, '归档后重新导入应重建，而不是拿归档行充数').toBe(false);
  });
});
