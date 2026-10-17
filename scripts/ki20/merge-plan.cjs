/**
 * 合并影响分析（**只读**）：把"远端 + 本机备份"做并集会发生什么、能清理掉什么。
 *
 * 用途：KI-20 存量修复的前置决策。我没有直接动手做合并，
 * 因为**污染不在服务器上**（服务器是纯 QQ 库、0 条注入），
 * 而"把本机 dsh 数据合并进去再传回服务器"会**改变生产库的记忆内容**——那是产品决策，不是清理。
 *
 * 用法:
 *   E:\nodejs24\node.exe scripts/ki20/merge-plan.cjs <remote.db> <local.db...>
 *
 * ⚠️ 纯只读。不写任何库、不产生中间文件。
 */
const path = require('path');

function loadSqlite() {
  for (const c of [
    path.join(__dirname, '..', '..', 'packages', 'core', 'node_modules', 'better-sqlite3'),
    'better-sqlite3',
  ]) { try { return require(c); } catch { /* 继续 */ } }
  console.error('找不到 better-sqlite3'); process.exit(2);
}
const Database = loadSqlite();

const PREFIX = 'Current runtime context';
const dbs = process.argv.slice(2).map(p => ({ p, db: new Database(p, { readonly: true }) }));

const stat = ({ p, db }) => {
  const ev = db.prepare('SELECT id, session_id, source, created_at FROM events').all();
  const injected = new Set(
    db.prepare("SELECT id FROM events WHERE json_extract(payload,'$.content') LIKE ? || '%'").all(PREFIX).map(r => r.id),
  );
  const prof = db.prepare('SELECT facts, character_facts FROM user_profile WHERE id = 1').get();
  return {
    p,
    ids: new Set(ev.map(e => e.id)),
    ev,
    injected,
    dsh: ev.filter(e => String(e.session_id).startsWith('dsh:')).length,
    facts: JSON.parse(prof?.facts || '[]').length,
    characterFacts: JSON.parse(prof?.character_facts || '[]').length,
    convs: db.prepare('SELECT COUNT(*) n FROM conversations').get().n,
    hints: JSON.parse(db.prepare('SELECT adaptation_hints FROM persona WHERE id = 1').get()?.adaptation_hints || '[]').length,
    maxAt: ev.length ? ev.map(e => e.created_at).sort().slice(-1)[0] : '',
  };
};

const S = dbs.map(stat);

console.log('=== 各库概况 ===');
for (const s of S) {
  console.log(`\n${path.basename(s.p)}`);
  console.log(`  events=${s.ev.length}  dsh=${s.dsh}  注入=${s.injected.size}`);
  console.log(`  facts=${s.facts}  character_facts=${s.characterFacts}  convs=${s.convs}  hints=${s.hints}`);
  console.log(`  最新事件=${s.maxAt}`);
}

const [remote, ...locals] = S;
console.log('\n=== 相对远端：本机各库**独有**的事件（并集会新增的部分）===');
for (const l of locals) {
  const only = [...l.ids].filter(id => !remote.ids.has(id));
  const onlyRows = l.ev.filter(e => !remote.ids.has(e.id));
  const onlyDsh = onlyRows.filter(e => String(e.session_id).startsWith('dsh:')).length;
  const onlyInjected = [...l.injected].filter(id => !remote.ids.has(id)).length;
  console.log(`\n${path.basename(l.p)}`);
  console.log(`  远端没有的事件: ${only.length}  其中 dsh=${onlyDsh}  **注入=${onlyInjected}**`);
  // 按会话前缀归类
  const byKind = {};
  for (const e of onlyRows) {
    const k = String(e.session_id).startsWith('dsh:') ? 'dsh'
      : String(e.session_id).startsWith('webui:') ? 'webui'
      : String(e.session_id).startsWith('qq') ? 'qq' : 'other';
    byKind[k] = (byKind[k] || 0) + 1;
  }
  console.log(`  独有事件按来源: ${JSON.stringify(byKind)}`);
}

console.log('\n=== 远端**独有**的事件（并集不会覆盖的部分）===');
for (const l of locals) {
  const only = [...remote.ids].filter(id => !l.ids.has(id));
  console.log(`  ${path.basename(remote.p)} 相对 ${path.basename(l.p)}: ${only.length}`);
}

console.log('\n=== 结论提示 ===');
const remoteInjected = remote.injected.size;
console.log(`远端注入事件 = ${remoteInjected}；本机备份里待清理的注入事件合计见上（并集后需要清理的量）。`);
console.log('⚠️ 并集会**把本机 dsh 会话并入生产库**（含其事实/摘要/注入事件）——这是内容变更，不是清理。');

for (const { db } of dbs) db.close();
