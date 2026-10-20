/**
 * 心情 → 头像观感（★ 2026-10-21，change: `her-mood-on-blog`）
 *
 * ## 为什么用 CSS 滤镜，而不是一堆表情图
 *
 * 一张官方头像（cyrene.webp）+ 按心情调色，比维护 8 张表情图省得多，
 * 也不会出现"某张图和她现在的人设不符"。代价是表情不变，只有色调/明度在动 ——
 * 但"她今天的颜色"本来就是最容易被感到的那一层。
 *
 * ## 数据从哪来
 *
 * `src/data/mood.json`。它是**她更新的东西**（生活系统写，或她自己在会话里写），
 * 构建时读进来。**不在运行时请求接口** —— 博客是纯静态站，跑在基站的子路径下，
 * 没有后端、也不该为一个头像去跨域调 API。
 *
 * ⚠️ 心情变了必须**重新构建 + 部署**才生效（`blog/deploy.ps1`）。
 * 这是静态站的固有代价，接受它换来"零后端、零攻击面"。
 */

import moodData from '../data/mood.json';

export type MoodKey =
  | 'happy'
  | 'calm'
  | 'tired'
  | 'sad'
  | 'excited'
  | 'lonely'
  | 'sleepy';

export interface Mood {
  key: MoodKey;
  /** 中文标签，显示在头像下面 */
  label: string;
  /** CSS filter 片段 */
  filter: string;
  /** 强调色（可选，给心情点用） */
  color: string;
}

/** 每种心情的观感。数值是手调的，不要随手改幅度 —— 过头会像滤镜坏掉 */
const MOODS: Record<MoodKey, Omit<Mood, 'key'>> = {
  happy:   { label: '开心',   filter: 'saturate(1.18) brightness(1.06)', color: '#f472b6' },
  calm:    { label: '平静',   filter: 'saturate(1) brightness(1)',       color: '#a78bfa' },
  tired:   { label: '有点累', filter: 'saturate(0.82) brightness(0.94)', color: '#94a3b8' },
  sad:     { label: '低落',   filter: 'saturate(0.62) brightness(0.90)', color: '#64748b' },
  excited: { label: '兴奋',   filter: 'saturate(1.32) brightness(1.10)', color: '#f59e0b' },
  lonely:  { label: '想你',   filter: 'saturate(0.88) brightness(0.97)', color: '#8b5cf6' },
  sleepy:  { label: '困了',   filter: 'saturate(0.72) brightness(0.86)', color: '#7c8aa5' },
};

const FALLBACK: MoodKey = 'calm';

export function getMood(): Mood & { note?: string; updatedAt?: string } {
  const raw = moodData as { mood?: string; note?: string; updatedAt?: string };
  const key = (raw.mood && raw.mood in MOODS ? raw.mood : FALLBACK) as MoodKey;
  return { key, ...MOODS[key], note: raw.note, updatedAt: raw.updatedAt };
}
