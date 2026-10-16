/**
 * 只读检查：openspec/specs 下所有**行首为 `+`** 的行（`+++` 除外）。
 *
 * 用法:
 *   E:\nodejs24\node.exe scripts/check-spec-diff-residue.cjs [根目录]
 *
 * ★ **退出码**（这是它能接进流程的原因）：
 *   发现任何行首 `+` → **exit 1**；零 → exit 0。
 *   ⇒ 可直接被 pre-commit / CI / `/openspec-archive` 技能调用，
 *     把「合并回主 spec 时忘了剥 `+ ` 前缀」变成**机器拦得住**的事
 *     （而不是靠人记得 —— 2026-09-25 就是靠人记得，结果 40 行留了 21 天）。
 *
 * ★★ 判据演进（吃过两次亏，记在这里）：
 *   ① **不能只在代码块外找**。第一版把「``` 内」当合法内容跳过，
 *      结果漏掉 15 行 —— 提示词模板（`+【心情】…` / `+- 迷迷…`）与
 *      ASCII 树（`+│ …`）里的残留**就在代码块内**，
 *      判据是「**兄弟行有没有 `+`**」（同块里别的行都没有 ⇒ 它那 `+` 是残留），
 *      而不是"在不在代码块里"。⇒ 现在**代码块内外都报**，并把在哪报出来供人判断。
 *   ② **模式不能只管 `+ ` 和 `+-`**。第二版用 `^\+[ -]`，漏了 `+│`（树角字符）
 *      与 `+【`（中文标题）—— 索引里早就写着 `ai-life-system` 混着 `+│`。
 *      ⇒ 现在判据是 **`^\+`（任意后继字符）**。
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, '..', 'openspec', 'specs');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

let total = 0;
const byFile = new Map();

for (const file of walk(root)) {
  // 先剥 BOM：带 BOM 的文件首行会变成 `\uFEFF+ …` ⇒ `^\+` 匹配不上
  // （本仓被 BOM 坑过；反测时正是它让"故意造的残留"没被拦下）
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/);
  let inFence = false;
  const hits = [];

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (/^\+/.test(line) && !/^\+\+\+/.test(line)) {
      total++;
      hits.push({ n: i + 1, line, inFence });
    }
  });

  if (hits.length) byFile.set(path.relative(root, file), hits);
}

console.log(`扫描根: ${root}`);
if (total === 0) {
  console.log('✅ 无残留（行首 `+` 的行为 0）。');
  process.exit(0);
}

console.log(`⛔ 发现 ${total} 行**行首为 + **（= apply 阶段漏剥前缀的残留，或文档里刻意的 diff 示例）：\n`);
for (const [rel, hits] of byFile) {
  console.log(`── ${rel}（${hits.length} 行）`);
  for (const h of hits) {
    console.log(`   ${h.n}${h.inFence ? ' [代码块内]' : '           '}: ${h.line.slice(0, 90)}`);
  }
  console.log('');
}
console.log('处理方式（二选一，**不要盲目删行**）：');
console.log('  ① **剥掉行首的 +**（保留其余内容与缩进）—— 绝大多数情况是残留。');
console.log('     本次实例里那 55 行都是主 spec 里**唯一**的一份内容，删了就是丢内容。');
console.log('  ② 若确实是文档刻意展示的 diff 示例 → 在该代码块前加一行 <!-- allow-diff -->');
console.log('     并把本脚本改成跳过标记后的那个块（**目前没有这种用例，故未实现豁免**）。');
process.exit(1);
