#!/usr/bin/env node
/**
 * ★ 2026-10-21（change: `add-works-gallery`）：把她生成的页面同步成博客「作品」栏目的数据。
 *
 * 数据来自服务端 runner 工作区（`/srv/alysia-runner/<项目>/public/`），
 * 由 `export-blog-data.py` 扫出来。这里只负责落盘成 `src/data/works.json`。
 *
 * ⚠️ 页面本身**不进博客构建产物**：它们由基站挂在 `/p/<projectId>/` 下。
 *    博客只提供入口 —— 否则两份副本迟早不一致。
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'blog/src/data/works.json');

const idx = process.argv.indexOf('--input');
const raw = idx >= 0 ? fs.readFileSync(process.argv[idx + 1], 'utf8') : fs.readFileSync(0, 'utf8');

let payload;
try {
	payload = JSON.parse(raw || '{}');
} catch {
	console.error('输入不是合法 JSON');
	process.exit(1);
}

const works = Array.isArray(payload?.works) ? payload.works : [];

// 只保留"至少有一页"的项目；路径一律相对（不含域名/IP —— 仓库是公开的）
const clean = works
	.filter((w) => Array.isArray(w.pages) && w.pages.length > 0)
	.map((w) => ({
		projectId: String(w.projectId ?? ''),
		pages: w.pages
			.filter((p) => typeof p?.file === 'string' && p.file.endsWith('.html'))
			.map((p) => ({
				file: p.file,
				title: String(p.title ?? p.file).slice(0, 80),
				description: String(p.description ?? '').slice(0, 160),
				updatedAt: Number(p.updatedAt ?? 0),
			})),
	}))
	.filter((w) => w.projectId && w.pages.length > 0);

if (clean.length === 0) {
	console.log('没有作品可同步（她的工作区里还没有可发布的页面）');
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');

const total = clean.reduce((n, w) => n + w.pages.length, 0);
console.log(`✓ works.json：${clean.length} 个项目 / ${total} 个页面`);
for (const w of clean) console.log(`  · ${w.projectId}: ${w.pages.map((p) => p.file).join(', ')}`);
