// src/life-templates.ts
// AI 生活事件通用模板（无角色特色的日常；角色特色事件由 LLM 结合世界书自创）
export interface LifeTemplate {
  activity: string;
  type: 'chat' | 'internal';
  weight: number;
}

export const LIFE_TEMPLATES: LifeTemplate[] = [
  { activity: '给自己倒了杯水', type: 'internal', weight: 5 },
  { activity: '翻着手机发呆，什么也没看进去', type: 'internal', weight: 4 },
  { activity: '整理了一下房间，把书摆整齐了', type: 'internal', weight: 3 },
  { activity: '听到楼下琴声，有点想学', type: 'chat', weight: 2 },
  { activity: '看到窗外的云朵像一只兔子', type: 'chat', weight: 2 },
  { activity: '泡了杯茶，坐在窗边慢慢喝', type: 'internal', weight: 4 },
  { activity: '翻到一张旧照片，想起一些往事', type: 'chat', weight: 2 },
  { activity: '在阳台看了会儿星星', type: 'chat', weight: 3 },
];
