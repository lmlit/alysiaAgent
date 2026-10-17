/**
 * KI-20 存量修复 · 合并（**以远端为基准，只追加 dsh 记忆**；默认 dry-run，绝不原地改）。
 *
 * 用法:
 *   E:\nodejs24\node.exe scripts/ki20/merge.cjs \
 *       --base <远端库> --append <清理后的 dsh 库> [--out <新库> --apply]
 *
 * ## 为什么"以远端为基准"而不是整库替换
 * 两条血脉的**派生状态**不同：远端 facts=56 / character_facts=33 / hints=243（**更新**），
 * 本机备份 facts=282 / character_facts=6 / hints=141（停在 10-02，**更旧**）。
 * 整库替换 = 用旧状态覆盖生产 ⇒ 她会**丢掉 33 条角色事实**、人格状态回退。
 * ⇒ 只把"她说过什么"（events / conversations）追加进去，**派生状态一律保留远端的**。
 *
 * ## 只追加 dsh（不追加 append 库里的 QQ/webui 事件）
 * 目标是"让 QQ 侧能用上 dsh 的记忆"。append 库里还有 146 条远端没有的**旧 QQ 事件**
 * —— 它们为什么不在远端，我们不知道（可能是当时删过/归档过）。
 * **不知道原因就不擅自塞回生产**，只报告数量，要塞是另一个决定。
 *
 * ## 同时做两件"必须同一次做"的事
 * 1. **`channel` 迁移**：基库若还没有该列则加列 + 回填（判据与 `utils/channel.ts` 一致）
 * 2. **存量 `channel` 回填**（change `add-memory-channel-field` 的 R9）：
 *    facts / character_facts / hints 的条目按 `source_event` 形态补标，判不出记 `unknown`
 *    —— 这三样是 JSON 列，刻意不放在启动路径里（每次启动 parse 整列不可接受）
 */
const fs = require('fs');
const path = require('path');

function loadSqlite() {
  for (const c of [path.join(__dirname, '..', '..', 'packages', 'core', 'node_modules', 'better-sqlite3'), 'better-sqlite3']) {
    try { return require(c); } catch { /* 继续 */ }
  }
  console.error('找不到 better-sqlite3'); process.exit(2);
}
const Database = loadSqlite();

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = arg('--base');
const APPEND = arg('--append');
const OUT = arg('--out');
const APPLY = argv.includes('--apply');

if (!BASE || !APPEND) { console.error('用法: --base <db> --append <db> [--out <new.db> --apply]'); process.exit(2); }
for (const f of [BASE, APPEND]) if (!fs.existsSync(f)) { console.error(`找不到 ${f}`); process.exit(2); }
if (OUT && [BASE, APPEND].some(p => path.resolve(p) === path.resolve(OUT))) {
  console.error('✗ 拒绝：`--out` 不能等于任一输入（本工具绝不原地改）'); process.exit(2);
}
if (OUT && !APPLY) { console.error('✗ 给了 `--out` 但没给 `--apply`'); process.exit(2); }
if (APPLY && !OUT) { console.error('✗ 给了 `--apply` 但没给 `--out`'); process.exit(2); }

/** 会话 → 渠道（与 core/src/utils/channel.ts 的 channelOfSession 同判据） */
const channelOfSession = (s) => {
  const v = String(s ?? '');
  if (v.startsWith('dsh:')) return 'dsh';
  if (v.startsWith('qq')) return 'qq';
  if (v.startsWith('webui:')) return 'webui';
  return 'unknown';
};
/** source_event 形态 → 渠道（**只用于存量回填**；判不出就是 unknown，不许猜） */
const channelOfSourceEvent = (se) => {
  const v = String(se ?? '');
  if (v.startsWith('dsh-') || v.startsWith('dsh:')) return 'dsh';
  if (v.startsWith('ROBOT1.0_') || v.startsWith('qq')) return 'qq';
  if (v.startsWith('life-')) return 'life';
  if (v.startsWith('proactive-')) return 'system';
  if (v.startsWith('reflection-')) return 'unknown'; // 合成 id，本仓契约明确不可溯源
  return 'unknown';
};

const base = new Database(BASE, { readonly: true });
const app = new Database(APPEND, { readonly: true });
const PREFIX = 'Current runtime context';
const INJ = `(json_extract(payload,'$.content') LIKE '${PREFIX}%' OR json_extract(payload,'$.synthetic')='runtime-context')`;
const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;

console.log(`基准库: ${BASE}`);
console.log(`追加源: ${APPEND}${APPLY ? `\n输出:   ${OUT}   ← 写新文件，两个输入只读` : '\n模式:   **dry-run**（不写任何东西）'}\n`);

// ── 现状 ────────────────────────────────────────────────────────
const baseEvents = count(base, 'SELECT COUNT(*) n FROM events');
const baseConvs = count(base, 'SELECT COUNT(*) n FROM conversations');
const baseCols = base.prepare('PRAGMA table_info(events)').all().map(c => c.name);
const hasChannel = baseCols.includes('channel');
console.log(`基准库: events=${baseEvents}  conversations=${baseConvs}  channel 列=${hasChannel ? '有' : '**无**（本次加）'}`);

// ── 要追加什么 ──────────────────────────────────────────────────
const appEvents = app.prepare(`SELECT * FROM events`).all();
const baseIds = new Set(base.prepare('SELECT id FROM events').all().map(r => r.id));
const dshEvents = appEvents.filter(e => String(e.session_id).startsWith('dsh:'));
const skipDup = dshEvents.filter(e => baseIds.has(e.id));
const toAdd = dshEvents.filter(e => !baseIds.has(e.id));
const qqOnlyInAppend = appEvents.filter(e => !String(e.session_id).startsWith('dsh:') && !baseIds.has(e.id));

console.log(`\n追加源: 共 ${appEvents.length} 事件`);
console.log(`  dsh 事件 ${dshEvents.length}（其中基准库已有 ${skipDup.length} → 去重跳过）`);
console.log(`  ⇒ **将追加 ${toAdd.length} 条 dsh 事件**`);
console.log(`  ⚠️ 另有 ${qqOnlyInAppend.length} 条**只存在于追加源**的非 dsh 事件（旧 QQ/webui）→ **本次不追加**（原因不明，不擅自塞回生产）`);
const injInAdd = toAdd.filter(e => /Current runtime context/.test(String(e.payload))).length;
console.log(`  追加集合里的注入事件残留: **${injInAdd}**（应为 0 —— 清理过；非 0 会中止）`);
if (injInAdd > 0) { console.error('✗ 追加源未清理干净，中止'); process.exit(1); }

const appConvs = app.prepare('SELECT * FROM conversations').all();
const baseConvIds = new Set(base.prepare('SELECT id FROM conversations').all().map(r => r.id));
const dshConvs = appConvs.filter(c => String(c.session_id).startsWith('dsh:'));
const addConvs = dshConvs.filter(c => !baseConvIds.has(c.id));
console.log(`  会话: dsh ${dshConvs.length} → 将追加 **${addConvs.length}** 条`);

// ── 画像/人格：保持基准库不动 ────────────────────────────────────
const prof = base.prepare('SELECT facts, character_facts FROM user_profile WHERE id = 1').get() || {};
const hintsRaw = base.prepare('SELECT adaptation_hints FROM persona WHERE id = 1').get()?.adaptation_hints;
const jparse = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
const facts = jparse(prof.facts), charFacts = jparse(prof.character_facts), hints = jparse(hintsRaw);
const missing = (arr) => arr.filter(x => !x.channel).length;
console.log(`\n画像/人格: **保持基准库原样**（facts=${facts.length} char=${charFacts.length} hints=${hints.length}）`);
console.log(`  存量缺 channel 的条目: facts ${missing(facts)} / char ${missing(charFacts)} / hints ${missing(hints)} → 本次回填`);

if (!APPLY) {
  console.log('\ndry-run 结束，**未写入任何文件**。');
  base.close(); app.close(); process.exit(0);
}

// ── 执行 ────────────────────────────────────────────────────────
console.log(`\n=== 执行（两个输入只读，写 ${OUT}）===`);
fs.copyFileSync(BASE, OUT);
const dst = new Database(OUT);
try {
  const tx = dst.transaction(() => {
    // 1. 迁移：加 channel 列 + 回填（与 core 的迁移同判据）
    for (const t of ['events', 'conversations']) {
      const cols = dst.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      if (!cols.includes('channel')) dst.exec(`ALTER TABLE ${t} ADD COLUMN channel TEXT DEFAULT ''`);
    }
    const backfill = (t) => dst.prepare(`UPDATE ${t} SET channel = CASE
        WHEN session_id LIKE 'dsh:%'   THEN 'dsh'
        WHEN session_id LIKE 'qq%'     THEN 'qq'
        WHEN session_id LIKE 'webui:%' THEN 'webui'
        ELSE 'unknown' END
      WHERE channel = '' OR channel IS NULL`).run().changes;

    // 2. 追加 dsh 事件（列单显式，channel 直接按 dsh 落库）
    const evCols = dst.prepare('PRAGMA table_info(events)').all().map(c => c.name);
    const insEv = dst.prepare(`INSERT INTO events (${evCols.join(',')}) VALUES (${evCols.map(() => '?').join(',')})`);
    let added = 0;
    for (const e of toAdd) {
      insEv.run(...evCols.map(c => (c === 'channel' ? 'dsh' : (e[c] ?? null))));
      added++;
    }

    // 3. 追加 dsh 会话
    const cvCols = dst.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
    const insCv = dst.prepare(`INSERT INTO conversations (${cvCols.join(',')}) VALUES (${cvCols.map(() => '?').join(',')})`);
    let addedCv = 0;
    for (const c of addConvs) { insCv.run(...cvCols.map(k => (k === 'channel' ? 'dsh' : (c[k] ?? null)))); addedCv++; }

    // 4. 存量 channel 回填（facts / character_facts / hints）
    const stamp = (arr) => arr.map(x => x.channel ? x : { ...x, channel: channelOfSourceEvent(x.source_event) });
    const f2 = stamp(facts), c2 = stamp(charFacts), h2 = hints.map(x => x.channel ? x : { ...x, channel: 'unknown' });
    dst.prepare('UPDATE user_profile SET facts=?, character_facts=? WHERE id=1')
      .run(JSON.stringify(f2, null, 2), JSON.stringify(c2, null, 2));
    dst.prepare('UPDATE persona SET adaptation_hints=? WHERE id=1').run(JSON.stringify(h2, null, 2));

    return { backfillEv: backfill('events'), backfillCv: backfill('conversations'), added, addedCv, f: f2.length, c: c2.length, h: h2.length };
  });
  const r = tx();
  dst.exec('VACUUM');
  console.log(`  迁移回填: events ${r.backfillEv} 行 / conversations ${r.backfillCv} 行`);
  console.log(`  追加: ${r.added} 条 dsh 事件 + ${r.addedCv} 条 dsh 会话`);
  console.log(`  存量回填: facts ${r.f} / char ${r.c} / hints ${r.h}（hints 无法溯源 → 一律 unknown）`);
} finally { dst.close(); }

// ── 校验 ────────────────────────────────────────────────────────
const ver = new Database(OUT, { readonly: true });
try {
  const integrity = ver.pragma('integrity_check')[0].integrity_check;
  const evTotal = count(ver, 'SELECT COUNT(*) n FROM events');
  const residual = ver.prepare(`SELECT COUNT(*) n FROM events WHERE ${INJ}`).get().n;
  console.log(`\n=== 校验 ${path.basename(OUT)} ===`);
  console.log(`  integrity_check: ${integrity}`);
  console.log(`  events: ${baseEvents} → ${evTotal}（应 +${toAdd.length}）  残留注入: **${residual}**（应 0）`);
  console.log('  按渠道:');
  for (const r of ver.prepare('SELECT channel, COUNT(*) n FROM events GROUP BY channel ORDER BY n DESC').all()) console.log(`     ${r.channel.padEnd(8)} ${r.n}`);
  const ok = integrity === 'ok' && residual === 0 && evTotal === baseEvents + toAdd.length;
  console.log(ok ? '\n✅ 合并完成（两个输入均未被修改）。' : '\n✗ 校验未通过');
  process.exit(ok ? 0 : 1);
} finally { ver.close(); base.close(); app.close(); }
