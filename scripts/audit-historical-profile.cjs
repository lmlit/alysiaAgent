#!/usr/bin/env node
'use strict';

/**
 * 历史画像**只读盘点**（★ 2026-10-26，decision: 历史画像回填 B 案）
 *
 * 回答一个问题：**要不要重放历史 `onSessionEnd` 补 basics/facts？**
 * 先看清规模与空洞在哪，再决定 —— 不做任何写入。
 *
 * 用法（生产容器内也可以，只读打开）：
 *   node scripts/audit-historical-profile.cjs [--db <path>] [--json]
 *   # 默认取 $ALYSIA_DB，再回落 /app/data/alysia.db（容器）与 ../packages/server/data/alysia.db（本机）
 *
 * 判据（proposal 里写死的）：
 *   - `facts` 为 0 且 `basics` 为空/`{}` 的会话 = **历史空洞**
 *   - `facts_status='failed'` = **已知可补**的窗口（比全量重放小得多）
 *   - `basics_stale=1` 且无当前事实 = 只能等新对话，重放也救不了
 */

const fs = require('fs');
const path = require('path');

// 根目录不装 better-sqlite3（它是 core/server 的依赖）；按顺序找可用的那份。
function loadSqlite() {
  const candidates = [
    'better-sqlite3',
    path.resolve(__dirname, '../packages/server/node_modules/better-sqlite3'),
    path.resolve(__dirname, '../packages/core/node_modules/better-sqlite3'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  console.error('找不到 better-sqlite3（请在装了它的包里跑，或用完整路径）。');
  process.exit(2);
}
const Database = loadSqlite();

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const dbArgIdx = argv.indexOf('--db');
const dbArg = dbArgIdx >= 0 ? argv[dbArgIdx + 1] : '';

const candidates = [
  dbArg,
  process.env.ALYSIA_DB,
  '/app/data/alysia.db',
  path.resolve(__dirname, '..', 'packages/server/data/alysia.db'),
].filter(Boolean);

const dbPath = candidates.find(p => fs.existsSync(p));
if (!dbPath) {
  console.error('找不到数据库。用 --db <path> 或设置 ALYSIA_DB。');
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function hasTable(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function hasColumn(table, col) {
  if (!hasTable(table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
function safeCount(sql, ...params) {
  try { return db.prepare(sql).get(...params).c; } catch { return null; }
}
function jsonLen(text) {
  if (typeof text !== 'string' || text.trim() === '') return 0;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.length : Object.keys(v || {}).length;
  } catch { return -1; }
}

const profile = hasTable('user_profile') ? db.prepare('SELECT * FROM user_profile WHERE id = 1').get() : null;

const summaryStatuses = {};
if (hasTable('conversations') && hasColumn('conversations', 'summary_status')) {
  for (const row of db.prepare('SELECT summary_status AS s, COUNT(*) AS c FROM conversations GROUP BY summary_status').all()) {
    summaryStatuses[row.s || 'null'] = row.c;
  }
}
const factsStatuses = {};
if (hasTable('conversations') && hasColumn('conversations', 'facts_status')) {
  for (const row of db.prepare('SELECT facts_status AS s, COUNT(*) AS c FROM conversations GROUP BY facts_status').all()) {
    factsStatuses[row.s || 'null'] = row.c;
  }
}

// 有事件、但从未产生过会话记录的 session（= 从来没有被结算过）
let sessionsWithEvents = 0;
let sessionsWithoutConversation = 0;
if (hasTable('events')) {
  sessionsWithEvents = safeCount('SELECT COUNT(DISTINCT session_id) AS c FROM events') ?? 0;
  if (hasTable('conversations')) {
    sessionsWithoutConversation = safeCount(
      `SELECT COUNT(*) AS c FROM (
         SELECT session_id FROM events GROUP BY session_id
         HAVING session_id NOT IN (SELECT session_id FROM conversations)
       )`,
    ) ?? 0;
  }
}

// 失败窗口：可直接补（facts_status='failed'），与“全量重放”区分开
const failedFacts = factsStatuses.failed ?? 0;
const placeholderSummaries = hasTable('conversations')
  ? safeCount("SELECT COUNT(*) AS c FROM conversations WHERE summary LIKE 'Session % summary'") ?? 0
  : 0;

const report = {
  db: dbPath,
  readonly: true,
  events: hasTable('events') ? safeCount('SELECT COUNT(*) AS c FROM events') ?? 0 : 0,
  conversations: hasTable('conversations') ? safeCount('SELECT COUNT(*) AS c FROM conversations') ?? 0 : 0,
  sessionsWithEvents,
  sessionsWithoutConversation,
  summaryStatuses,
  factsStatuses,
  placeholderSummaries,
  failedFacts,
  profile: profile ? {
    basicsChars: typeof profile.basics === 'string' ? profile.basics.trim().length : 0,
    basicsIsEmptyObject: typeof profile.basics === 'string' && profile.basics.trim() === '{}',
    facts: jsonLen(profile.facts),
    characterFacts: jsonLen(profile.character_facts),
    basicsSourceKeys: jsonLen(profile.basics_source),
    basicsStale: !!profile.basics_stale,
  } : null,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('历史画像只读盘点（未写入任何东西）');
  console.log(`  DB: ${report.db}`);
  console.log(`  events: ${report.events} / sessions(有事件): ${report.sessionsWithEvents}`);
  console.log(`  conversations: ${report.conversations}（从未结算的 session: ${report.sessionsWithoutConversation}）`);
  console.log(`  summary_status: ${JSON.stringify(report.summaryStatuses)}`);
  console.log(`  facts_status:   ${JSON.stringify(report.factsStatuses)}`);
  console.log(`  占位摘要: ${report.placeholderSummaries} / facts 失败窗口: ${report.failedFacts}`);
  if (report.profile) {
    const p = report.profile;
    console.log(`  basics: ${p.basicsChars} 字${p.basicsIsEmptyObject ? '（空对象）' : ''}，` +
      `facts: ${p.facts}，character_facts: ${p.characterFacts}，basics_source: ${p.basicsSourceKeys} 键，stale: ${p.basicsStale}`);
  }
  console.log('');
  console.log('判据：failedFacts > 0 ⇒ 先补这些窗口（D 案）；sessionsWithoutConversation 大 ⇒ 才是全量重放（C 案）的成本来源。');
}
