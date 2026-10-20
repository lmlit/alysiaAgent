#!/usr/bin/env node
/**
 * ★ 2026-10-21（change: `sync-mood-to-blog`）：把服务端的心情同步成博客的 `mood.json`。
 *
 * 之前 `mood.json` 是手改的 —— 那不是"她更新心情的前端"，只是一张静态图。
 * 现在由 `deploy.ps1` 在构建前从 `ai_life_state` 拉下来写入。
 *
 * ⚠️ 两件事必须处理对：
 * ① 服务端 mood 是**中文词**（"平静"），而前端 `utils/mood.ts` 用的是英文 key（`calm`），
 *    所以这里做映射；映射不到就用 `moodValue` 的正负兜底，再不行回 `calm`。
 * ② `note` 是**她自己写的一句话**，会显示在侧栏 —— 属于公开内容。
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'blog/src/data/mood.json');

/** 中文/近义词 → 前端 key（`utils/mood.ts` 的 MOODS 全集） */
const KEYWORDS = [
	[['开心', '高兴', '愉快', '雀跃', '欢喜', '满足'], 'happy'],
	[['兴奋', '激动', '期待', '雀跃不已'], 'excited'],
	[['平静', '安静', '平稳', '安宁', '还好', '踏实'], 'calm'],
	[['想你', '想念', 'lonely', '孤单', '寂寞', '空落'], 'lonely'],
	[['累', '疲惫', '疲', '乏', '倦'], 'tired'],
	[['困', '睡意', '犯困', ' drowsy'], 'sleepy'],
	[['低落', '难过', '伤心', '失落', '沉', '难受', '委屈'], 'sad'],
];

function toKey(mood, moodValue) {
	const text = String(mood ?? '').trim().toLowerCase();
	if (!text) return fallbackByValue(moodValue);

	// 先精确命中前端 key（服务端万一直接存英文）
	const direct = ['happy', 'excited', 'calm', 'lonely', 'tired', 'sleepy', 'sad'];
	if (direct.includes(text)) return text;

	for (const [words, key] of KEYWORDS) {
		if (words.some((w) => text.includes(w.toLowerCase()))) return key;
	}
	return fallbackByValue(moodValue);
}

function fallbackByValue(v) {
	const n = Number(v ?? 0);
	if (n >= 0.35) return 'happy';
	if (n >= 0.1) return 'calm';
	if (n <= -0.35) return 'sad';
	if (n <= -0.1) return 'lonely';
	return 'calm';
}

const idx = process.argv.indexOf('--input');
const raw =
	idx >= 0 ? fs.readFileSync(process.argv[idx + 1], 'utf8') : fs.readFileSync(0, 'utf8');

let payload;
try {
	payload = JSON.parse(raw || '{}');
} catch {
	console.error('输入不是合法 JSON');
	process.exit(1);
}

const mood = payload?.mood ?? {};
if (!mood || Object.keys(mood).length === 0) {
	console.log('服务端没有心情数据，保留现有 mood.json');
	process.exit(0);
}

const key = toKey(mood.mood, mood.moodValue);
const next = {
	mood: key,
	updatedAt: mood.updatedAt || new Date().toISOString(),
	note: String(mood.note || '').slice(0, 60),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
fs.writeFileSync(OUT, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

console.log(
	`✓ mood.json: ${prev?.mood ?? '-'} → ${key}（服务端原值「${mood.mood || '空'}」` +
		`${mood.moodValue != null ? `, value=${mood.moodValue}` : ''}）` +
		`${next.note ? `  note=「${next.note}」` : ''}`,
);
