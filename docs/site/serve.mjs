#!/usr/bin/env node
/**
 * Alysia 文档站 —— 只读静态服务
 *
 * 为什么需要它：浏览器在 `file://` 下**不能 fetch 本地 .md**（CORS 拦），
 * 而把 21 篇文档内嵌进一个 HTML 会产生"第二份真相"（改 md 得重新生成）。
 * ⇒ 用一个只读服务，文档永远只有磁盘上那一份，刷新即见。
 *
 * 设计约束（别破坏）：
 *   1. **只读**：不写任何文件，不监听非回环地址。
 *   2. **白名单**：只暴露 `docs/**`、`CLAUDE.md`、`openspec/specs/index.md`。
 *   3. **零依赖**：只用 node 内置模块，不装包（装了就要动 lockfile）。
 *   4. 导航数据**现解析 `docs/README.md` 的分类总表** —— 改那张表，侧栏就跟着变。
 *      解析失败 → 降级成按文件名平铺，绝不白屏。
 *
 * 启动：node docs/site/serve.mjs        （默认 127.0.0.1:7801）
 *      PORT=8000 node docs/site/serve.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, extname, sep } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
const SITE = join(ROOT, 'docs', 'site');
const PORT = Number(process.env.PORT || 7801);
const HOST = '127.0.0.1';

/** 允许通过 /api/md 读取的范围（相对仓库根的 posix 路径） */
const READABLE = [
  (p) => p.startsWith('docs/') && p.endsWith('.md'),
  // ★ 放开整个 openspec/**：文档里到处是 `openspec/specs/<slug>/spec.md` 这类链接，
  //   不放行的话点进去全是 404。归档 change 也一并能读（本地只读，风险可接受）。
  (p) => p.startsWith('openspec/') && p.endsWith('.md'),
  (p) => p === 'CLAUDE.md',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** 仓库相对路径 → 绝对路径；越界返回 null */
function safeResolve(rel) {
  const norm = normalize(rel.replace(/\\/g, '/')).replace(/^([./\\])+/, '');
  if (norm.startsWith('..') || norm.includes('..' + sep) || norm.includes('../')) return null;
  const abs = join(ROOT, norm);
  if (!abs.startsWith(ROOT + sep) && abs !== ROOT) return null;
  return abs;
}

/**
 * 解析 `docs/README.md` 的「分类总表」。
 *
 * 表格形状（README 维护规则保证）：
 *   | 类 | 文档 | status | updated | 受众 |
 *   | **A 宪法** | [`../CLAUDE.md`](../CLAUDE.md) | current | 2026-10-18 | ai |
 *   |            | [`../openspec/project.md`](...) —— 说明 | current | — | ai |
 *
 * 第一列留空 = 沿用上一行的分类。
 */
function parseNav(markdown) {
  const groups = [];
  const byKey = new Map();
  let cur = null;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;

    const cells = line.split('|').slice(1, -1).map((s) => s.trim());
    if (cells.length < 5) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // 分隔行
    if (cells[0] === '类' || cells[1] === '文档') continue; // 表头

    const [clsCell, docCell, status, updated, audience] = cells;

    // 解析文档链接：[`label`](path) —— 说明
    const link = docCell.match(/\[([^\]]*)\]\(([^)]+)\)/);
    if (!link) continue;

    const label = link[1].replace(/[`*]/g, '').trim();
    const href = link[2].trim();
    if (/^https?:/.test(href)) continue;

    // 相对 docs/ 解析成仓库相对路径
    let rel = href.startsWith('.') || !href.includes('/') ? normalize('docs/' + href) : normalize(href);
    rel = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    if (rel === 'docs/README.md' && !clsCell) continue;

    const descMatch = docCell.slice(docCell.indexOf(href) + href.length).match(/^\s*—\s*(.+)$/);
    const isDir = !rel.endsWith('.md');

    if (clsCell) {
      const m = clsCell.replace(/\*\*/g, '').match(/^([A-Z])\s*(.*)$/);
      const key = m ? m[1] : clsCell;
      const title = m ? m[2] : clsCell;
      if (!byKey.has(key)) {
        cur = { key, title, items: [] };
        byKey.set(key, cur);
        groups.push(cur);
      } else {
        cur = byKey.get(key);
      }
    }
    if (!cur) continue;

    cur.items.push({
      path: rel,
      label: label || rel,
      desc: descMatch ? descMatch[1].trim() : '',
      status: status || 'current',
      updated: updated || '—',
      audience: audience || '—',
      kind: isDir ? 'dir' : 'doc',
    });
  }

  return groups;
}

/** 解析失败时的兜底：把 docs/ 下的 md 平铺成一组 */
async function fallbackNav() {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(join(ROOT, 'docs'))).filter((f) => f.endsWith('.md')).sort();
  return [
    {
      key: '?',
      title: '全部文档（README 分类表解析失败，已降级）',
      items: files.map((f) => ({
        path: 'docs/' + f,
        label: f,
        desc: '',
        status: 'current',
        updated: '—',
        audience: '—',
        kind: 'doc',
      })),
    },
  ];
}

async function readDoc(rel) {
  if (!READABLE.some((fn) => fn(rel))) return null;
  const abs = safeResolve(rel);
  if (!abs) return null;
  try {
    return await readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(buf);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = decodeURIComponent(url.pathname);

  // ── 导航
  if (path === '/api/nav') {
    try {
      const md = await readFile(join(ROOT, 'docs', 'README.md'), 'utf8');
      const groups = parseNav(md);
      if (!groups.length) throw new Error('empty');
      const total = groups.reduce((n, g) => n + g.items.length, 0);
      const stale = groups.reduce(
        (n, g) => n + g.items.filter((i) => i.status !== 'current').length,
        0,
      );
      return json(res, 200, { ok: true, groups, total, stale });
    } catch (err) {
      const groups = await fallbackNav();
      return json(res, 200, {
        ok: false,
        degraded: String(err && err.message),
        groups,
        total: groups[0].items.length,
        stale: 0,
      });
    }
  }

  // ── 文档原文
  if (path === '/api/md') {
    const rel = (url.searchParams.get('p') || '').replace(/\\/g, '/');
    const text = await readDoc(rel);
    if (text === null) return json(res, 404, { error: 'not found or not readable', path: rel });
    res.writeHead(200, { 'content-type': MIME['.md'], 'cache-control': 'no-store' });
    return res.end(text);
  }

  // ── 站点自身（index.html）
  const file = path === '/' ? join(SITE, 'index.html') : safeResolve('docs/site' + path);
  if (!file) return json(res, 400, { error: 'bad path' });
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log(`[docs] 端口 ${PORT} 已被占用 —— 大概率是它已经在跑了：`);
    console.log(`[docs]   → http://${HOST}:${PORT}/`);
    console.log('[docs] 换端口：PORT=8000 node docs/site/serve.mjs');
    process.exit(0);
  }
  console.error('[docs] 启动失败：', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[docs] 文档站已启动 → http://${HOST}:${PORT}/`);
  console.log(`[docs] 仓库根：${ROOT}`);
  console.log(`[docs] 只读服务，暴露 docs/** + openspec/**（仅 .md）+ CLAUDE.md`);
});
