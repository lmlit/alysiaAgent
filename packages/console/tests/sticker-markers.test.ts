// tests/sticker-markers.test.ts
// ★ change: improve-sticker-system（首版：`[表情包:名字]` 渲染闭环）
//
// 这是**新功能**，不是修 bug —— 所以没有"先红后绿"，本文件是与实现同时写下的**契约**。
// 它守的是三件最容易写错的事：
//   ① 标记解析要**与服务端一致**（全角括号/冒号），否则「QQ 发得出、console 显不出」
//   ② 流式期间**不显示半截标记**，但**也不能顺手吃掉正文里的方括号**
//   ③ 一条标记只产出一个图片片段（不重复插图）
import { describe, it, expect } from 'vitest';
import {
  parseStickerMarkers,
  stripTrailingPartialMarker,
} from '../lib/chat/sticker-markers';

const kinds = (s: ReturnType<typeof parseStickerMarkers>) => s.map(x => x.kind);
const names = (s: ReturnType<typeof parseStickerMarkers>) =>
  s.filter((x): x is { kind: 'sticker'; name: string } => x.kind === 'sticker').map(x => x.name);

describe('parseStickerMarkers — 基本解析', () => {
  it('纯文本 → 单个文本片段（不因为没标记就返回空）', () => {
    const r = parseStickerMarkers('今天天气不错');
    expect(r).toEqual([{ kind: 'text', text: '今天天气不错' }]);
  });

  it('★ 行内标记 → 文本/图片/文本 三段，且**顺序保持**（位置语义）', () => {
    const r = parseStickerMarkers('好呀 [表情包:开心] 那我们走吧');
    expect(kinds(r)).toEqual(['text', 'sticker', 'text']);
    expect(r[0]).toEqual({ kind: 'text', text: '好呀 ' });
    expect(names(r)).toEqual(['开心']);
    expect(r[2]).toEqual({ kind: 'text', text: ' 那我们走吧' });
  });

  it('★ 兼容全角括号与全角冒号（与服务端 qq-official 同一套判据）', () => {
    expect(names(parseStickerMarkers('［表情包：开心］'))).toEqual(['开心']);
    expect(names(parseStickerMarkers('[ 表情包 : 开心 ]'))).toEqual(['开心']);
  });

  it('多个标记 → 各自一个图片片段（不合并）', () => {
    const r = parseStickerMarkers('[表情包:a]中间[表情包:b]');
    expect(names(r)).toEqual(['a', 'b']);
    expect(kinds(r)).toEqual(['sticker', 'text', 'sticker']);
  });

  it('★ 一条标记只产出一个片段（不重复插图）', () => {
    const r = parseStickerMarkers('[表情包:开心]');
    expect(r).toEqual([{ kind: 'sticker', name: '开心' }]);
    expect(r).toHaveLength(1);
  });

  it('标记在结尾 → 不留下空文本片段', () => {
    expect(parseStickerMarkers('给你看[表情包:开心]')).toEqual([
      { kind: 'text', text: '给你看' },
      { kind: 'sticker', name: '开心' },
    ]);
  });

  it('名字两侧空白被裁掉（`[表情包: 开心 ]`）', () => {
    expect(names(parseStickerMarkers('[表情包: 开心 ]'))).toEqual(['开心']);
  });

  it('★ 名字为空的标记 → **丢掉**、不产片段（与服务端 `replace` 掉的行为一致）', () => {
    const r = parseStickerMarkers('a[表情包: ]b');
    expect(kinds(r)).not.toContain('sticker');
    // 标记本身消失，前后正文保留（不渲染成"空名字的表情包"）
    expect(r.map(x => (x.kind === 'text' ? x.text : '')).join('')).toBe('ab');
  });
});

describe('★ parseStickerMarkers — 流式期间不显示半截标记', () => {
  const streaming = (t: string) => parseStickerMarkers(t, { streaming: true });

  it.each([
    ['[', '刚打了半个括号'],
    ['[表', '表'],
    ['[表情', '表情'],
    ['[表情包', '表情包'],
    ['[表情包:', '刚打完冒号'],
    ['[表情包:开心', '名字还没写完'],
    ['好呀 [表情包:开', '正文 + 半截标记'],
  ])('★ %s → 结尾半截标记被藏起（%s）', (text) => {
    const r = streaming(text);
    expect(r.every(x => x.kind === 'text' ? !x.text.includes('表情包') : true)).toBe(true);
    // 具体：正文之后不该出现任何「表情包」字样
    expect(r.map(x => (x.kind === 'text' ? x.text : '')).join('')).not.toContain('表情包');
  });

  it('★ 半截标记之前的正文照常显示', () => {
    expect(streaming('好呀 [表情包:开')).toEqual([{ kind: 'text', text: '好呀 ' }]);
  });

  it('★★ 但**不能**顺手吃掉正文里的方括号（`[表示同意` 不是标记前缀）', () => {
    expect(streaming('[表示同意')).toEqual([{ kind: 'text', text: '[表示同意' }]);
    expect(streaming('算一下 [1+1')).toEqual([{ kind: 'text', text: '算一下 [1+1' }]);
    expect(streaming('[情')).toEqual([{ kind: 'text', text: '[情' }]);
  });

  it('★ 流结束后一律原样解析：未闭合的标记**当正文**（那时它已不可能是标记）', () => {
    expect(parseStickerMarkers('[表情包:开心')).toEqual([{ kind: 'text', text: '[表情包:开心' }]);
  });

  it('★ 已完成的标记在流式期间照常立即渲染（不必等流结束）', () => {
    expect(streaming('好呀 [表情包:开心]')).toEqual([
      { kind: 'text', text: '好呀 ' },
      { kind: 'sticker', name: '开心' },
    ]);
  });
});

describe('stripTrailingPartialMarker — 判据本身', () => {
  it('是标记前缀 → 截掉', () => {
    expect(stripTrailingPartialMarker('abc[表情包:')).toBe('abc');
  });
  it('不是标记前缀 → 原样返回', () => {
    expect(stripTrailingPartialMarker('abc[xyz')).toBe('abc[xyz');
  });
  it('结尾没有方括号 → 原样返回', () => {
    expect(stripTrailingPartialMarker('abc')).toBe('abc');
  });
  it('只处理**结尾**那一个：正文中间的方括号不受影响', () => {
    expect(stripTrailingPartialMarker('[1+1] 算好了 [表情包:开心]')).toBe(
      '[1+1] 算好了 [表情包:开心]',
    );
  });
});
