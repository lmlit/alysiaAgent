// tests/memory/worldbook-sample-cooldown.test.ts
// ★ 2026-10-16 · change: `worldbook-sampling-cooldown`
//
// 契约（`ai-life-system` §6/§7）声明世界书采样要「priority 加权 + **cooldown 过滤**」，
// 但实现是**两条路径不一致**：
//
//   - **对话触发**路径 `WorldbookStore.match()` —— **有**冷却过滤（`cooldown_sec`）。
//   - **事件生成器采样**路径 `MemoryManager.getWorldbookSample()` —— **没有**：
//     只 `ORDER BY RANDOM() LIMIT n`，从不看 `last_triggered`。
//
// 而 `bumpWorldbookHit()` 的注释写着「**与对话触发共用冷却**」——
// 写入侧（`recordTrigger` 记 `last_triggered`）做了，读取侧（采样）没看，属**声明了没接**。
//
// ★ 为什么不能直接用条目自带的 `cooldown_sec`（默认 **300 秒**）：
//   事件生成器是**每小时** tick（`life.ts` 间隔 0.5~8h，默认 1h）。
//   5 分钟的冷却在小时级节奏上**等于没有** —— 下一轮照样抽到同一条。
//   ⇒ 采样窗口必须另有一个够长的下界（本实现取 6h），
//     并**同时**尊重条目自己声明的更长冷却（取 max），
//     这样 `bumpWorldbookHit` 那句「共用冷却」才是真的。
//
// ★ 影响面如实记：线上 `last_triggered` 非空的条目**只有 2 条**（95 条里）
//   ⇒ 这是**契约缺口**，不是正在烧的事故。所以修法取最小、不引入新旋钮。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';

const HOUR = 3_600_000;

function makeMM(db: Database.Database): MemoryManager {
  return new MemoryManager(
    db as any, null as any,
    { embed: async () => [0], dimension: () => 1024 } as any,
    { complete: async () => '{}' } as any,
  );
}

describe('★ 世界书采样必须看冷却（契约：cooldown 过滤）', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  /** 播一条 text 世界书条目；`usedAgoMs` 为空 = 从未被用过 */
  const seed = (id: string, content: string, usedAgoMs: number | null, cooldownSec = 300) =>
    db.prepare(
      `INSERT INTO worldbook_entries
         (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec,
          last_triggered, hit_count, created_at, updated_at, role, content_type)
       VALUES (?, '[""]', 'any', ?, 'chat', 10, ?, ?, 0, '2026-08-06T00:00:00', '2026-08-06T00:00:00',
               'alysia', 'text')`,
    ).run(
      id,
      content,
      cooldownSec,
      usedAgoMs === null ? null : new Date(Date.now() - usedAgoMs).toISOString(),
    );

  const sampleContents = () => mm.getWorldbookSample(5).map(s => s.content);

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    mm = makeMM(db);
  });
  afterEach(() => db.close());

  it('★★ 主症：刚用过（1 小时前）的条目**不得**再被采样（旧实现只 ORDER BY RANDOM）', () => {
    seed('wb-used', '一小时前刚用过的设定', 1 * HOUR);

    // 只有这一条 text 条目 ⇒ textCount=2 会把唯一候选取出来；修好后候选集为空
    expect(
      sampleContents(),
      '刚用过的条目又被递给了事件生成器 —— 冷却没生效',
    ).toEqual([]);
  });

  it('★ 冷却过后会回来：7 小时前用过（cooldown_sec=300）→ 重新可采样', () => {
    seed('wb-stale', '七小时前用过的设定', 7 * HOUR);
    expect(sampleContents()).toContain('七小时前用过的设定');
  });

  it('★ 从未用过的条目**始终**可采样', () => {
    seed('wb-never', '从没用过的设定', null);
    expect(sampleContents()).toContain('从没用过的设定');
  });

  it('★★ 条目自己声明的**更长**冷却同样生效（max 语义，"共用冷却"才是真的）', () => {
    // cooldown_sec = 24h（条目显式要求长冷却），7 小时前用过
    // —— 6h 采样窗口已过，但 24h 的条目冷却还没到 ⇒ 仍应排除
    seed('wb-long', '要求长冷却的设定', 7 * HOUR, 24 * 3600);
    seed('wb-never2', '没被用过的设定', null);

    const got = sampleContents();
    expect(got, '条目声明的 24h 冷却被忽略了').not.toContain('要求长冷却的设定');
    expect(got).toContain('没被用过的设定');
  });

  it('★ 候选恰好够数时是确定的：4 条里只应取到 2 条合格的（textCount=2）', () => {
    seed('c-used', 'A 刚用过', 1 * HOUR);
    seed('c-stale', 'B 七小时前用过', 7 * HOUR);
    seed('c-never', 'C 从没用过', null);
    seed('c-long', 'D 长冷却', 7 * HOUR, 24 * 3600);

    const got = sampleContents();
    expect(got.sort()).toEqual(['B 七小时前用过', 'C 从没用过']);
  });

  it('★★ 与写入侧共用同一个字段：`bumpWorldbookHit()` 之后立刻采样，该条目必须消失', () => {
    seed('wb-hit', '被事件引用了的设定', null);
    expect(sampleContents()).toContain('被事件引用了的设定');

    mm.bumpWorldbookHit('wb-hit');   // ← 真实写入路径（recordTrigger → last_triggered）

    expect(
      sampleContents(),
      'bumpWorldbookHit 记了 last_triggered，但采样侧没看它 —— 两个路径没接上',
    ).not.toContain('被事件引用了的设定');
  });

  it('★ 回归：`life_event` 种子同样受冷却约束（两条 SQL 都要改，别只改一条）', () => {
    db.prepare(
      `INSERT INTO worldbook_entries
         (id, trigger_keys, trigger_mode, content, scope, priority, cooldown_sec,
          last_triggered, hit_count, created_at, updated_at, role, content_type)
       VALUES ('wb-life-used', '[""]', 'any', '刚讲过的日常种子', 'chat', 10, 300, ?, 0,
               '2026-08-06T00:00:00', '2026-08-06T00:00:00', 'alysia', 'life_event')`,
    ).run(new Date(Date.now() - 1 * HOUR).toISOString());

    expect(sampleContents(), 'life_event 那条被漏掉了（只改了 text 的 SQL）').not.toContain('刚讲过的日常种子');
  });
});
