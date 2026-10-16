/**
 * 日志画像 —— 度量「级别分布 + 模块 tag 占比 + 信噪比」。
 *
 * 用法:
 *   E:\nodejs24\node.exe scripts/log-profile.cjs <logfile> [topN]
 *
 * ★ 为什么需要它（change: `add-ops-health-report` 的**前置评估**）：
 *   立项记录写着「19,556 INFO : 16 WARN : 11 ERROR」「**96.6% 的日志行是 QQ Official**」
 *   —— 于是 WARN 等于不存在、日志和信号之间没有连接（摘要 22 天 100% 失败而全程绿）。
 *   用户当时的判断是「**我们日志系统建好其实监控很好做的**」，
 *   并明确要求**先评估日志系统本身**：否则在 96.6% 噪声上建监控 = 把日报也埋进去。
 *
 *   ⇒ 本脚本把「噪声有多少、在哪」变成**可重复的数字**，而不是靠印象。
 *
 * ⚠️ 只读。不删除、不改写、不采样丢行（全量统计）。
 */
const fs = require('fs');

const file = process.argv[2];
const TOP = Number(process.argv[3]) || 12;
if (!file) {
  console.error('用法: node scripts/log-profile.cjs <logfile> [topN]');
  process.exit(2);
}

const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
const total = lines.length;

// 形如: [2026-10-16 22:56:15] [INFO] [Realtime] 消息…
// 兼容没有时间戳/没有级别/没有 tag 的行
const LEVEL_RE = /\[(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]/;
const TAG_RE = /\[(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]\s*\[([^\]]+)\]/;

const byLevel = new Map();
const byTag = new Map();
let unparsed = 0;

for (const line of lines) {
  const lm = line.match(LEVEL_RE);
  if (lm) byLevel.set(lm[1], (byLevel.get(lm[1]) ?? 0) + 1);
  else unparsed++;

  const tm = line.match(TAG_RE);
  const tag = tm ? tm[1] : '(无 tag)';
  byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
}

const pct = (n) => ((n / total) * 100).toFixed(1) + '%';
const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

console.log(`文件: ${file}`);
console.log(`非空行: ${total}${unparsed ? `（其中 ${unparsed} 行没匹配到级别标记）` : ''}\n`);

console.log('── 级别分布 ──');
for (const [k, v] of sorted(byLevel)) console.log(`  ${k.padEnd(6)} ${String(v).padStart(7)}  ${pct(v)}`);

const warn = byLevel.get('WARN') ?? 0;
const err = byLevel.get('ERROR') ?? 0;
const info = byLevel.get('INFO') ?? 0;
console.log(`\n信噪比: 每 1000 行有 ${(((warn + err) / total) * 1000).toFixed(2)} 行 WARN+ERROR` +
  `（INFO : WARN : ERROR = ${info} : ${warn} : ${err}）`);
console.log(info / Math.max(1, warn + err) > 100
  ? '  ⚠️ INFO 比 WARN+ERROR 高两个数量级 ⇒ **warn 等于不存在**（立项记录的同一形态）'
  : '  ✅ 级别分布尚可用于告警');

console.log(`\n── 模块 tag 占比（前 ${TOP}）──`);
for (const [k, v] of sorted(byTag).slice(0, TOP)) console.log(`  ${k.padEnd(22)} ${String(v).padStart(7)}  ${pct(v)}`);
const topTag = sorted(byTag)[0];
if (topTag && topTag[1] / total > 0.5) {
  console.log(`\n⚠️ 单一来源「${topTag[0]}」占 ${pct(topTag[1])} —— 噪声会淹掉真信号（立项记录是 96.6% QQ Official）`);
} else if (topTag) {
  console.log(`\n✅ 最大单一来源「${topTag[0]}」占 ${pct(topTag[1])}，未形成压倒性噪声`);
}
