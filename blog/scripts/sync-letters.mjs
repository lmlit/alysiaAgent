#!/usr/bin/env node
/**
 * ★ 2026-10-21（change: `add-letters`）：把服务端的「信」同步成博客文章。
 *
 * 与 `sync-diaries.mjs` 同构（幂等、不删旧、category 区分），
 * 区别只在：信不按日 —— 可能几周没有一封，那很正常。
 *
 * 产物：`blog/src/content/posts/letter-<date>.md`（category: 信 → 走 /letters/ 栏目）
 */
import fs from 'node:fs';
import path from 'node:path';

const POSTS = path.join(process.cwd(), 'blog/src/content/posts');
const LETTER_CATEGORY = '信';

/** 信不按心情换封面（它不是每天都有的情绪快照），统一用一张安静的人像 */
const LETTER_ART = '19';

function cnTitle(date) {
	const [, m, d] = date.split('-');
	return `${Number(m)} 月 ${Number(d)} 日`;
}

function excerpt(content, max = 48) {
	const flat = String(content ?? '').replace(/\n+/g, ' ').trim();
	if (flat.length <= max) return flat;
	const head = flat.slice(0, max);
	const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('…'));
	return cut >= 20 ? head.slice(0, cut + 1) : `${head}…`;
}

const idx = process.argv.indexOf('--input');
const raw = idx >= 0 ? fs.readFileSync(process.argv[idx + 1], 'utf8') : fs.readFileSync(0, 'utf8');
const payload = JSON.parse(raw || '{}');
const rows = Array.isArray(payload) ? payload : Array.isArray(payload.letters) ? payload.letters : [];

if (rows.length === 0) {
	console.log('没有信可同步（她这段时间没写 —— 这是正常的，不是失败）');
	process.exit(0);
}

fs.mkdirSync(POSTS, { recursive: true });
let written = 0;

for (const r of rows) {
	const date = String(r.date ?? '').slice(0, 10);
	const content = String(r.content ?? '').replace(/\r\n/g, '\n').trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || content.length < 20) {
		console.warn(`跳过（日期或内容不合法）: ${JSON.stringify(r).slice(0, 60)}`);
		continue;
	}

	const coverFile = `letter-${date}.webp`;
	const hasCover = fs.existsSync(path.join(POSTS, coverFile));

	const md = [
		'---',
		`title: ${JSON.stringify(cnTitle(date))}`,
		`published: ${date}`,
		`description: ${JSON.stringify(excerpt(content))}`,
		`tags: [${JSON.stringify('信')}]`,
		`category: ${LETTER_CATEGORY}`,
		...(hasCover ? [`image: "./${coverFile}"`] : []),
		'draft: false',
		'lang: zh_CN',
		'---',
		'',
		content,
		'',
	].join('\n');

	const file = path.join(POSTS, `letter-${date}.md`);
	fs.writeFileSync(file, md, 'utf8');
	written++;
	console.log(`✓ letter-${date}.md  ${content.length} 字  封面=${hasCover ? coverFile : '无'}`);
}

console.log(`同步完成：${written}/${rows.length}`);
