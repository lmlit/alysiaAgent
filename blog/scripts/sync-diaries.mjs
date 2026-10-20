#!/usr/bin/env node
/**
 * ★ 2026-10-21（change: `add-daily-diary`）：把服务端的日记同步成博客文章。
 *
 * 数据来自 `MemoryManager.listDiaries()`（服务端导出 JSON），
 * 由 `deploy.ps1` 在构建前通过 ssh 拉下来喂给本脚本。
 *
 * 用法：
 *   ssh <host> "python3 ... 导出" | node blog/scripts/sync-diaries.mjs
 *   node blog/scripts/sync-diaries.mjs --input diary.json
 *
 * 产物：`blog/src/content/posts/diary-<date>.md`（category: 日记 → 走 /diary/ 栏目）
 *
 * ⚠️ 三条约定：
 * ① **幂等**：同一天重复同步会覆盖同一个文件，不会产生 `diary-2026-10-20-2.md`
 * ② **不删旧日记**：服务端没有的日期不会删本地文件（历史不该因为一次同步消失）
 * ③ **mood 落进 frontmatter**：博客按它选封面
 */
import fs from 'node:fs';
import path from 'node:path';

const POSTS = path.join(process.cwd(), 'blog/src/content/posts');
const DIARY_CATEGORY = '日记';

/** 每篇日记的封面：按心情从素材库挑（与 make-covers.py 的素材 id 对齐） */
const MOOD_COVER = {
	happy: '18',
	excited: '07',
	calm: '05',
	lonely: '19',
	tired: '12',
	sleepy: '13',
	sad: '21',
};

/** mood → 中文标签（标签页上显示英文键太丑，也没人看得懂） */
const MOOD_LABEL = {
	happy: '开心',
	excited: '兴奋',
	calm: '平静',
	lonely: '想你',
	tired: '有点累',
	sleepy: '困了',
	sad: '低落',
};

/**
 * 摘要：截到**句末**，别切在半句。
 * （第一版按 60 字硬切，出现了"他说" / "浇。" 这种断头句）
 */
function excerpt(content, max = 56) {
	const flat = content.replace(/\n+/g, ' ').trim();
	if (flat.length <= max) return flat;
	const head = flat.slice(0, max);
	const cut = Math.max(
		head.lastIndexOf('。'),
		head.lastIndexOf('！'),
		head.lastIndexOf('？'),
		head.lastIndexOf('…'),
	);
	if (cut >= 24) return head.slice(0, cut + 1);
	return `${head}…`;
}

function readInput() {
	const idx = process.argv.indexOf('--input');
	if (idx >= 0) {
		return JSON.parse(fs.readFileSync(process.argv[idx + 1], 'utf8'));
	}
	// 从 stdin 读（deploy.ps1 走这条）
	const raw = fs.readFileSync(0, 'utf8');
	return JSON.parse(raw || '[]');
}

/** 「10 月 20 日」—— 标题用中文日期，比 ISO 更像人写的 */
function cnTitle(date) {
	const [, m, d] = date.split('-');
	return `${Number(m)} 月 ${Number(d)} 日`;
}

/** 日记正文里的空行规范成段落；不碰内容本身 */
function normalize(content) {
	return String(content ?? '').replace(/\r\n/g, '\n').trim();
}

const rows = readInput();
if (!Array.isArray(rows)) {
	console.error('输入必须是数组');
	process.exit(1);
}
if (rows.length === 0) {
	console.log('没有日记可同步（服务端还没写过）');
	process.exit(0);
}

fs.mkdirSync(POSTS, { recursive: true });
let written = 0;

for (const r of rows) {
	const date = String(r.date ?? '').slice(0, 10);
	const content = normalize(r.content);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || content.length < 20) {
		console.warn(`跳过（日期或内容不合法）: ${JSON.stringify(r).slice(0, 80)}`);
		continue;
	}

	const mood = String(r.mood ?? '').trim();
	const coverId = MOOD_COVER[mood] ?? '05';
	// 封面文件由 make-covers.py 按素材 id 生成为 diary-<date>.webp；
	// 若还没生成，先不写 image 字段（别指向不存在的文件）
	const coverFile = `diary-${date}.webp`;
	const hasCover = fs.existsSync(path.join(POSTS, coverFile));

	const md = [
		'---',
		`title: ${JSON.stringify(cnTitle(date))}`,
		`published: ${date}`,
		`description: ${JSON.stringify(excerpt(content))}`,
		`tags: [${JSON.stringify(MOOD_LABEL[mood] ?? '日记')}]`,
		`category: ${DIARY_CATEGORY}`,
		...(hasCover ? [`image: "./${coverFile}"`] : []),
		'draft: false',
		'lang: zh_CN',
		'---',
		'',
		content,
		'',
	].join('\n');

	// 覆盖同一文件 ⇒ 幂等；文件名固定用日期
	const file = path.join(POSTS, `diary-${date}.md`);
	fs.writeFileSync(file, md, 'utf8');
	written++;
	console.log(`✓ diary-${date}.md  mood=${mood || '-'}  封面=${hasCover ? coverFile : '无（等 make-covers）'}`);
}

console.log(`同步完成：${written}/${rows.length}`);
