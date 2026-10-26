#!/usr/bin/env node
'use strict';

/**
 * 裸 catch 闸（★ 2026-10-26，change: `harden-silent-failures`，KI-5）
 *
 * 为什么有它：`catch {}` 把「出错了」降级成「没有发生」（见 docs/SILENT-FAILURE.md §2），
 * 而同族的每一次事故都不是靠"下次注意"止住的。KI-5 清到 0 之后，这里负责**不让它长回来**。
 *
 * 判据（刻意窄）：
 *   - **真·空 catch**（块内既没有代码、也没有注释）⇒ 命中；
 *   - `catch { /* 说明 *\/ }` ⇒ **不算**（有说明，是刻意的降级，不是吞）；
 *   - `catch (e) { … }` 里有任何代码 ⇒ 不算。
 * 这样才不会把仓里那批「注释说明过的 best-effort」全部误报，
 * 也不会因为 strip 掉注释而把它们变成假阳性。
 *
 * 扫 `packages/<pkg>/src`，跳过注释与字符串里的 `catch`（本仓史料很多，不能自伤）。
 * 退出码：命中 ⇒ 1；干净 ⇒ 0。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [
  'packages/core/src',
  'packages/server/src',
  'packages/dsh-adapter/src',
  'packages/dsh-console/src',
  'packages/console/src',
];

const lineAt = (src, index) => src.slice(0, index).split('\n').length;

/**
 * 从 `{` 之后扫描一个块：
 *   - 返回块内是否有**代码**（字符串算代码）与是否有**注释**；
 *   - 花括号按深度配对（catch 块里可能有对象字面量）。
 */
function scanBlock(src, start) {
  let i = start;
  let depth = 1;
  let state = 'code'; // code | line | block | '"' | "'" | '`'
  let hasCode = false;
  let hasComment = false;

  while (i < src.length && depth > 0) {
    const c = src[i];
    const n = src[i + 1];

    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; hasComment = true; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; hasComment = true; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = c; hasCode = true; i++; continue; }
      if (c === '{') { depth++; hasCode = true; i++; continue; }
      if (c === '}') { depth--; i++; continue; } // 闭合本层；不计为代码
      if (!/\s/.test(c)) hasCode = true;
      i++;
      continue;
    }

    if (state === 'line') {
      if (c === '\n') state = 'code';
      i++;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue; }
      i++;
      continue;
    }

    // 字符串内部
    if (c === '\\') { i += 2; continue; }
    if (c === state) { state = 'code'; i++; continue; }
    i++;
  }

  return { hasCode, hasComment, end: i };
}

/** 在代码态里找 `catch`，解析可选的 `(…)`，再看紧跟的块。 */
function findBareCatches(src) {
  const hits = [];
  let i = 0;
  let state = 'code';

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = c; i++; continue; }

      const prev = src[i - 1] || '';
      if (c === 'c' && src.startsWith('catch', i) && !/[\w$]/.test(prev)) {
        let j = i + 5;
        while (/\s/.test(src[j])) j++;

        // 可选的绑定/类型参数：(e) / (e: unknown)
        if (src[j] === '(') {
          let depth = 0;
          while (j < src.length) {
            if (src[j] === '(') depth++;
            else if (src[j] === ')') { depth--; if (depth === 0) { j++; break; } }
            j++;
          }
          while (/\s/.test(src[j])) j++;
        }

        if (src[j] === '{') {
          const { hasCode, hasComment, end } = scanBlock(src, j + 1);
          if (!hasCode && !hasComment) hits.push({ line: lineAt(src, i) });
          i = end;
          continue;
        }
      }

      i++;
      continue;
    }

    if (state === 'line') {
      if (c === '\n') state = 'code';
      i++;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue; }
      i++;
      continue;
    }

    if (c === '\\') { i += 2; continue; }
    if (c === state) { state = 'code'; i++; continue; }
    i++;
  }

  return hits;
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

const files = [];
for (const rel of SCAN_DIRS) walk(path.join(ROOT, rel), files);

const hits = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const h of findBareCatches(src)) {
    hits.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), line: h.line });
  }
}

if (hits.length > 0) {
  console.error('✗ 发现裸 `catch {}`（错误被降级成「没有发生」）：');
  for (const h of hits) console.error(`  ${h.file}:${h.line}`);
  console.error('');
  console.error('改法：能抛就抛；不能抛就 warn + 计数/跳过，或写成 `catch { /* 为什么可以忽略 */ }`。');
  console.error('判据见 docs/SILENT-FAILURE.md §2 / §7。');
  process.exit(1);
}
