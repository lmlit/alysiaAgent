// 内容模型（这就是"规范"本体）
//
// 加一篇随笔 = 往 src/content/essays/ 放一个 .md；schema 不过就构建失败，
// 不会再出现"手写 html + 改 publish.sh 白名单"那种事。
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const essays = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/essays' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.string(),          // YYYY-MM-DD（保持字符串：这是叙述日期，不是排序时间戳）
    minutes: z.number().int().positive().default(2),
    /** 「01 · 清晨」这种编号/时段标签，可选 */
    kicker: z.string().optional(),
    /** 迁移来源（旧 html 文件名），便于回溯；新写的可省 */
    source: z.string().optional(),
  }),
});

export const collections = { essays };
