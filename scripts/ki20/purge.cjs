/**
 * KI-20 存量数据清理（**只读报告 / 输出到新库，绝不原地改**）。
 *
 * 用法:
 *   E:\nodejs24\node.exe scripts/ki20/purge.cjs --in <db>                 # dry-run：只报告
 *   E:\nodejs24\node.exe scripts/ki20/purge.cjs --in <db> --out <new.db> --apply
 *
 * ★ 安全设计（每一条都是刻意的）：
 *   1. **绝不原地改**：`--out` 等于 `--in` 直接拒绝。写入方式是把 `--in` 拷成 `--out` 再改，
 *      所以 `--in` 全程只读。
 *   2. **默认 dry-run**：没有 `--apply` 就一个字都不写（想改必须两个参数都给）。
 *   3. **不敢自己决定的事就中止**：若发现"摘要正文里含注入前缀"的会话，
 *      **直接 abort** 并把清单打出来让人定 —— 静默改写摘要是丢内容。
 *
 * 清理对象（`docs/KNOWN-ISSUES.md` KI-20）：
 *   - **注入事件**：dsh 的「runtime context 快照」被当用户消息回传入库（180 条）
 *     判据：`payload.content` 以 `Current runtime context` 开头
 *           **或** `payload.synthetic = 'runtime-context'`（新版才有的标记，老数据没有）
 *   - **派生事实**：`source_event` 指向被删事件的那些 `facts` / `character_facts` 条目
 *     （留着它们 = 让"从未发生过的对话"沉淀成对她的认知）
 *   - **hints 只报告不删**：有先例（`purge-subagent-pollution`）判定"像真实偏好回放"，
 *     内容本身是真的（用户在编程会话里确实说过那些话），只是入口脏
 *   - **向量**：本脚本**不动向量库**（那是 DB 之外的另一套存储）。
 *     本仓既有判据："垃圾向量比缺一条向量危险得多" ⇒ 报告需要处理的 id，
 *     实际处理随合并方案的向量策略走（计划里选的是"服务器侧重新嵌入"）。
 */
const fs = require('fs');
const path = require('path');

function loadSqlite() {
  for (const c of [
    path.join(__dirname, '..', '..', 'packages', 'core', 'node_modules', 'better-sqlite3'),
    'better-sqlite3',
  ]) { try { return require(c); } catch { /* 继续 */ } }
  console.error('找不到 better-sqlite3'); process.exit(2);
}
const Database = loadSqlite();

// ── 参数 ───────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const IN = arg('--in');
const OUT = arg('--out');
const APPLY = argv.includes('--apply');

if (!IN) { console.error('用法: --in <db> [--out <new.db> --apply]'); process.exit(2); }
if (!fs.existsSync(IN)) { console.error(`找不到 ${IN}`); process.exit(2); }
if (OUT && path.resolve(OUT) === path.resolve(IN)) {
  console.error('✗ 拒绝：`--out` 不能等于 `--in`（本工具绝不原地改）'); process.exit(2);
}
if (OUT && !APPLY) { console.error('✗ 给了 `--out` 但没给 `--apply` —— 想写就显式加 `--apply`'); process.exit(2); }
if (APPLY && !OUT) { console.error('✗ 给了 `--apply` 但没给 `--out`'); process.exit(2); }

const PREFIX = 'Current runtime context';
const INJ_WHERE = `(json_extract(payload,'$.content') LIKE '${PREFIX}%'
                OR json_extract(payload,'$.synthetic') = 'runtime-context')`;

const src = new Database(IN, { readonly: true });
const q = (sql, ...a) => src.prepare(sql).all(...a);

console.log(`源库: ${IN}${APPLY ? `\n输出: ${OUT}   ← 会写入新文件，源库只读` : '\n模式: **dry-run**（不写任何东西）'}\n`);

// ── 1. 注入事件 ─────────────────────────────────────────────────
const inj = q(`SELECT id, session_id, created_at, substr(json_extract(payload,'$.content'),1,48) AS head
               FROM events WHERE ${INJ_WHERE} ORDER BY created_at`);
const injIds = new Set(inj.map(r => r.id));
console.log(`① 注入事件: **${inj.length}** 条`);
if (inj.length) {
  const times = inj.map(r => r.created_at).sort();
  console.log(`   时间跨度: ${times[0]} → ${times[times.length - 1]}`);
  console.log(`   涉及会话: ${new Set(inj.map(r => r.session_id)).size} 个`);
  console.log(`   样例: ${inj[0].head.slice(0, 36)}…`);
  const bySess = {};
  for (const r of inj) bySess[r.session_id] = (bySess[r.session_id] || 0) + 1;
  console.log(`   按会话: ${Object.entries(bySess).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, n]) => `${s.slice(0, 22)}(${n})`).join(', ')}`);
}

// ── 2. 派生事实 ─────────────────────────────────────────────────
const prof = src.prepare('SELECT facts, character_facts FROM user_profile WHERE id = 1').get() || {};
const splitFacts = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };
const facts = splitFacts(prof.facts);
const charFacts = splitFacts(prof.character_facts);
const derivedFacts = facts.filter(f => injIds.has(String(f.source_event)));
const derivedChar = charFacts.filter(f => injIds.has(String(f.source_event)));
console.log(`\n② 派生事实（source_event 指向被删事件）`);
console.log(`   facts:            ${derivedFacts.length} / ${facts.length}`);
console.log(`   character_facts:  ${derivedChar.length} / ${charFacts.length}`);
for (const f of derivedFacts.slice(0, 5)) console.log(`     - ${String(f.fact).slice(0, 60)}`);

// ── 3. 摘要含注入前缀的会话（**不自己决定**）─────────────────────
const badConv = q(`SELECT id, session_id, substr(summary,1,60) AS head FROM conversations
                   WHERE summary LIKE '${PREFIX}%' OR summary LIKE '%${PREFIX}%'`);
console.log(`\n③ 摘要含注入前缀的会话: **${badConv.length}** 条`);
if (badConv.length) {
  for (const c of badConv.slice(0, 8)) console.log(`     - ${c.id}  ${c.head.slice(0, 48)}…`);
  console.log('   ⚠️ 这类**不自动处理**：改摘要正文 = 可能丢内容，需要人定（清空？重摘？保留？）');
}

// ── 4. hints（只报告）───────────────────────────────────────────
const hints = splitFacts(src.prepare('SELECT adaptation_hints AS h FROM persona WHERE id = 1').get()?.h);
const winHints = hints.filter(h => {
  const t = String(h.applied_at || '');
  return t >= '2026-10-01' && t <= '2026-10-03';
});
console.log(`\n④ adaptation_hints: 共 ${hints.length} 条，落在注入窗口(10-01~10-02)的 **${winHints.length}** 条`);
console.log('   ⇒ **建议保留**（先例 `purge-subagent-pollution`：内容是真实的用户偏好回放，只是入口脏）');

// ── 5. 向量 ─────────────────────────────────────────────────────
console.log(`\n⑤ 向量：本脚本不动向量库（DB 之外的另一套存储）`);
console.log(`   需要另行处理的 id 共 ${injIds.size} 个（事件 id）—— 随合并方案的向量策略一起做`);

// ── 结论 / 写入 ─────────────────────────────────────────────────
console.log('\n=== 小结 ===');
console.log(`将被删除: ${inj.length} 条事件 + ${derivedFacts.length} 条 facts + ${derivedChar.length} 条 character_facts`);
console.log(`保留: hints（建议）、会话摘要（需人定）`);

if (!APPLY) {
  console.log('\ndry-run 结束，**未写入任何文件**。（要执行：加 `--out <新库> --apply`）');
  src.close();
  process.exit(0);
}

// ── 执行（写新文件）─────────────────────────────────────────────
console.log(`\n=== 执行（源库只读，写 ${OUT}）===`);
fs.copyFileSync(IN, OUT);
const dst = new Database(OUT);
try {
  const tx = dst.transaction(() => {
    const del = dst.prepare(`DELETE FROM events WHERE ${INJ_WHERE}`).run();
    const keepFacts = facts.filter(f => !injIds.has(String(f.source_event)));
    const keepChar = charFacts.filter(f => !injIds.has(String(f.source_event)));
    dst.prepare('UPDATE user_profile SET facts = ?, character_facts = ? WHERE id = 1')
      .run(JSON.stringify(keepFacts, null, 2), JSON.stringify(keepChar, null, 2));
    return { del: del.changes, facts: facts.length - keepFacts.length, char: charFacts.length - keepChar.length };
  });
  const r = tx();
  dst.exec('VACUUM');
  console.log(`  删除事件 ${r.del} 条；移除 facts ${r.facts} 条、character_facts ${r.char} 条`);
} finally { dst.close(); }

// 复制出来的库自己是可写副本，verification 用只读打开
const ver = new Database(OUT, { readonly: true });
try {
  const integrity = ver.prepare('PRAGMA integrity_check').get().integrity_check;
  const left = ver.prepare(`SELECT COUNT(*) n FROM events WHERE ${INJ_WHERE}`).get().n;
  const evTotal = ver.prepare('SELECT COUNT(*) n FROM events').get().n;
  console.log(`\n=== 校验 ${path.basename(OUT)} ===`);
  console.log(`  integrity_check: ${integrity}`);
  console.log(`  残留注入事件: **${left}**（应为 0）`);
  console.log(`  事件总数: ${evTotal}`);
  if (left !== 0 || integrity !== 'ok') { console.error('✗ 校验未通过'); process.exit(1); }
} finally { ver.close(); }
src.close();
console.log('\n✅ 清理完成（源库未被修改）。');
