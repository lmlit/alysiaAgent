// ★ 2026-10-18 · change: fix-receipt-link-to-produced-page
//
// 真机事故：用户点回执里的 `…/p/alysia-toys/` 看到的是「月光花园」（凌晨做的第一个玩具），
// 不是她刚做完的海岛。契约 38 早就写了"回执带的是**她刚做的那个页面**"，impl 没接。
//
// 这里钉三件事：
//   1. 地址必须指向**本轮产物页**，不是项目门牌
//   2. 没发布（不在 public/）⇒ 走 `/w/` 预览前缀；发布了 ⇒ 走 `/p/`
//   3. 服务端只接受由**该项目 publicUrl 派生**的地址（越界串一律不采用，回落门牌）

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pickPageUrl, allowedUrlPrefixes } from '../src/webui/receipt-url.js';
// @ts-expect-error —— 宿主脚本是 .mjs，没有类型声明（故意的：它要能被 node 直跑）
import { artifactPages, pageUrl, previewBase } from '../../../scripts/project-task-runner.mjs';

const BASE = 'http://hub.test:3389/p/alysia-toys/';

describe('previewBase：/p/ → /w/', () => {
  it('★ 把项目地址换成预览前缀', () => {
    expect(previewBase(BASE)).toBe('http://hub.test:3389/w/alysia-toys/');
  });

  it('结尾有无斜杠都认', () => {
    expect(previewBase('http://h:1/p/x')).toBe('http://h:1/w/x/');
  });

  it('形状不认识 ⇒ 原样返回（宁可不猜）', () => {
    expect(previewBase('http://h:1/foo/')).toBe('http://h:1/foo/');
    expect(previewBase('')).toBe('');
  });
});

describe('pageUrl：已发布走 /p/，没发布走 /w/', () => {
  it('★ 未发布 ⇒ 预览地址（否则 404）', () => {
    expect(pageUrl(BASE, { path: 'island.html', published: false }))
      .toBe('http://hub.test:3389/w/alysia-toys/island.html');
  });

  it('★ 已发布 ⇒ 正式地址', () => {
    expect(pageUrl(BASE, { path: 'island.html', published: true }))
      .toBe('http://hub.test:3389/p/alysia-toys/island.html');
  });

  it('index.html = 目录本身（不再拼一次文件名）', () => {
    expect(pageUrl(BASE, { path: 'index.html', published: true })).toBe(BASE);
  });

  it('没有页面 ⇒ 回落项目门牌', () => {
    expect(pageUrl(BASE, null)).toBe(BASE);
  });
});

describe('artifactPages：只认本轮动过的根目录页面', () => {
  const make = () => {
    const ws = mkdtempSync(join(tmpdir(), 'pt-artifacts-'));
    mkdirSync(join(ws, 'drafts'));
    mkdirSync(join(ws, 'public'));
    writeFileSync(join(ws, 'old.html'), '<h1>上一轮</h1>');
    writeFileSync(join(ws, 'island.html'), '<h1>海岛</h1>');
    writeFileSync(join(ws, 'drafts', 'a.html'), '<h1>草稿</h1>');
    writeFileSync(join(ws, 'NOTES.md'), '# 笔记');
    // old.html 挪到 1 小时前
    const past = (Date.now() - 3600_000) / 1000;
    utimesSync(join(ws, 'old.html'), past, past);
    return ws;
  };

  it('★ 只回本轮改过的（old.html 不算）、不递归 drafts/、忽略非 html', () => {
    const ws = make();
    const since = Date.now() - 60_000;
    const got = artifactPages(ws, since, () => false);
    expect(got.map(g => g.path)).toEqual(['island.html']);
  });

  it('published 由回调判定（public/ 里有没有同名页）', () => {
    const ws = make();
    writeFileSync(join(ws, 'public', 'island.html'), '<h1>海岛</h1>');
    const got = artifactPages(ws, Date.now() - 60_000, rel => rel === 'island.html');
    expect(got).toEqual([{ path: 'island.html', published: true }]);
  });

  it('index.html 在并列时让位（它是门牌，不是"这一件的名字"）', () => {
    const ws = make();
    writeFileSync(join(ws, 'index.html'), '<h1>门牌</h1>');
    const got = artifactPages(ws, Date.now() - 60_000, () => false);
    expect(got[0].path).toBe('island.html');
    expect(got.map(g => g.path)).toContain('index.html');
  });

  it('工作区读不到 ⇒ 空数组（不抛）', () => {
    expect(artifactPages('/nonexistent/xx', Date.now(), () => false)).toEqual([]);
  });
});

describe('pickPageUrl：服务端只采用"本项目派生"的地址', () => {
  it('★ 本轮的产物页地址优先于项目门牌', () => {
    const page = 'http://hub.test:3389/w/alysia-toys/island.html';
    expect(pickPageUrl(BASE, [{ path: 'island.html', url: page }])).toBe(page);
  });

  it('已发布地址（/p/）也认', () => {
    const page = 'http://hub.test:3389/p/alysia-toys/island.html';
    expect(pickPageUrl(BASE, [{ path: 'island.html', url: page }])).toBe(page);
  });

  it('★ 越界地址一律忽略，回落门牌（防伪造回传）', () => {
    expect(pickPageUrl(BASE, [{ url: 'http://evil.example/x.html' }])).toBe(BASE);
    expect(pickPageUrl(BASE, [{ url: 'http://hub.test:3389/p/other-project/x.html' }])).toBe(BASE);
  });

  it('没有 artifacts / 形状不对 ⇒ 门牌', () => {
    expect(pickPageUrl(BASE, [])).toBe(BASE);
    expect(pickPageUrl(BASE, null)).toBe(BASE);
    expect(pickPageUrl(BASE, [{ url: 42 }])).toBe(BASE);
  });

  it('项目没配 publicUrl ⇒ undefined（不乱编地址）', () => {
    expect(pickPageUrl(undefined, [{ url: 'http://x/y.html' }])).toBeUndefined();
  });

  it('合法前缀 = 目录 + /w/ 兄弟', () => {
    expect(allowedUrlPrefixes('http://h:1/p/x')).toEqual(['http://h:1/p/x/', 'http://h:1/w/x/']);
    expect(allowedUrlPrefixes('')).toEqual([]);
  });
});
