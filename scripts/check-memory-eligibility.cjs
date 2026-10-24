/**
 * 记忆资格判据**不许复制**（只读检查）。
 *
 * ★ 2026-10-21（change: `unify-memory-eligibility`，契约 C1）
 *
 * 背景：同一个问题（"这条内容允许用于这个用途吗"）此前被四份代码各答一次，
 * 写法互不相同 —— `EventStore` 的 SQL / `RealtimeProcessor`（只看 skip_profile）/
 * `ProfileExtractor`（不看 synthetic）/ `SessionEndProcessor`（不看 role）。
 * 于是"能不能学"取决于你恰好走哪条路径：合成注入在正常摘要里被滤掉、
 * 在补处理里又被收进去（E1）；她自己的话进了人格扫描（E4）。
 *
 * 修法不是"再补几个 if"，是**把判据收进 `eligibility.ts`** ——
 * 所以这条规则必须是机器拦得住的，否则下次加学习路径时一定又被抄一遍。
 *
 * 用法:
 *   node scripts/check-memory-eligibility.cjs [--strict]
 * 退出码:
 *   0 = 通过
 *   1 = 在 processors/engines 里发现自带资格判定（应当改调 isEligible/filterEligible）
 *   2 = 用法/路径问题
 *
 * 规则:
 *   ① （始终）`packages/core/src/memory/{processors,engines}/*.ts` 内
 *      **不许**读 `payload.synthetic` / `payload.skip_profile` / `.skip_profile`。
 *      判据只允许出现在 `eligibility.ts` 与 store 层 SQL（性能原因，见 spec §A 契约 2）。
 *   ② （始终）同一范围内**不许**调用 `getAllFacts()` ——
 *      那是"审计专用"的全量出口，业务读取必须走 `getCurrentFacts()`（契约 C2）。
 *      这条自 2026-10-21 T3 落地后默认生效（`--strict` 仅为向后兼容保留，行为相同）。
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const strict = process.argv.includes('--strict');

const SCANNED_DIRS = [
  path.join(root, 'packages', 'core', 'src', 'memory', 'processors'),
  path.join(root, 'packages', 'core', 'src', 'memory', 'engines'),
];

/**
 * 白名单：文件名 → 允许命中的原因。
 * **留一条就要写一句理由**（否则白名单会自己长成第二个判据）。
 */
const ALLOW = new Map([
  // 例：['SomeFile.ts', '这里必须读原始标记，理由…'],
]);

const RULES = [
  {
    id: 'C1-source-predicate',
    // 只抓"读标记"的形态：`payload.synthetic` / `payload?.skip_profile` / `e.payload.skip_profile`
    // 赋值（`payload.skip_profile = true`）是**写**标记，属于 ingest 侧，不在本范围。
    re: /\.(synthetic|skip_profile)\b/g,
    hint: '资格判定必须调 eligibility.ts 的 isEligible()/filterEligible()，不许在这里自己读标记',
    fatal: true,
  },
  {
    // ★ 2026-10-21（T3 落地后）起**默认拦截**：业务读取必须走 getCurrentFacts()，
    //   `getAllFacts()` 只留给审计/测试
    id: 'C2-audit-only-getAllFacts',
    re: /\bgetAllFacts\s*\(/g,
    hint: 'getAllFacts() 是**审计专用**（含 superseded/expired）。业务读取请走 getCurrentFacts()',
    fatal: true,
  },
];

function walkTs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

let fatalHits = 0;
let advisoryHits = 0;

for (const dir of SCANNED_DIRS) {
  for (const file of walkTs(dir)) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const base = path.basename(file);
    if (ALLOW.has(base)) continue;

    const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);

    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 跳过注释行：注释里写「不要读 payload.synthetic」是**说明**，不是判据
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        rule.re.lastIndex = 0;
        if (!rule.re.test(line)) continue;

        const where = `${rel}:${i + 1}`;
        if (rule.fatal) {
          fatalHits++;
          console.error(`❌ [${rule.id}] ${where}\n   ${line.trim()}\n   → ${rule.hint}`);
        } else {
          advisoryHits++;
          console.warn(`⚠️  [${rule.id}] ${where}（--strict 才拦）\n   ${line.trim()}\n   → ${rule.hint}`);
        }
      }
    }
  }
}

if (fatalHits > 0) {
  console.error(`\n共 ${fatalHits} 处违反判据纪律（见上方规则 id）。`);
  console.error('判据的唯一出处是 packages/core/src/memory/eligibility.ts。');
  process.exit(1);
}
if (advisoryHits > 0) {
  console.warn(`\n共 ${advisoryHits} 处提示项（未拦截）。`);
}
console.log(strict
  ? '✅ 通过（含 --strict：无自带资格判定，无全量事实读取）'
  : '✅ 通过（无自带资格判定；`--strict` 额外检查 getAllFacts）');
