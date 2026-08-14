/**
 * ★ 8-14 内容自进化工具（content-self-evolution）
 *
 * 昔涟可往自己的持久内容库写新条目：
 * - write_worldbook：新回忆/设定 → worldbook（触发词 + ≤250 字正文）
 * - add_life_template：新日常活动 → life 模板池（weight 固定 2）
 *
 * 删除仅响应明确用户指令（description 硬约束），LLM 不得自主删除。
 * 写入校验（查重 + LLM 校验器）在 MemoryManager 内部完成，异常降级拒写。
 * 通知 = 内容浮现：工具 result 供主循环 LLM 把新内容当回忆自然说出，不做操作汇报。
 */
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { ToolDefinition } from './registry.js';

export function createSelfEvolveTools(memoryManager: MemoryManager): ToolDefinition[] {
  return [
    {
      name: 'write_worldbook',
      description: '把一段新的回忆或设定写进自己的世界书（持久设定库）。' +
        '只写关于你（昔涟）自己的事或你的世界的设定——你的经历、喜好、往事、世界观；' +
        '绝不写用户的事实或隐私。内容要具体、确定，模糊不清的不要写；不要写离谱或危险的内容。' +
        '写入后，之后聊到触发词时会自然想起这段内容。调用后把这段新内容当作一段回忆自然地提起，不要汇报操作细节。',
      parameters: {
        type: 'object',
        properties: {
          trigger_keys: {
            type: 'string',
            description: 'JSON 数组：未来触发这段回忆的关键词（1-3 个，如 ["阳台","发光的花"]）',
          },
          content: {
            type: 'string',
            description: '条目正文（≤250 字）：这段回忆/设定的具体内容',
          },
        },
        required: ['trigger_keys', 'content'],
      },
      handler: async (args) => {
        let keys: string[];
        try {
          keys = JSON.parse(String(args.trigger_keys ?? '[]')) as string[];
        } catch {
          keys = [String(args.trigger_keys ?? '')];
        }
        const r = await memoryManager.addWorldbookEntry({ triggerKeys: keys, content: String(args.content ?? '') });
        if (!r.ok) return `这次不记了——${r.reason}`;
        return `记下了：${String(args.content).slice(0, 60)}${String(args.content).length > 60 ? '…' : ''}（以后聊到${keys.join('、')}时会想起）`;
      },
    },
    {
      name: 'add_life_template',
      description: '把你发明的一个新的日常活动加进生活模板池（LLM 事件生成失败时的兜底活动池）。' +
        '只加关于你自己的日常活动；不加用户的安排或偏好。内容要具体、确定，模糊的不要写。' +
        '调用后可以自然地提起这个新习惯，不要汇报操作细节。',
      parameters: {
        type: 'object',
        properties: {
          activity: {
            type: 'string',
            description: '活动描述（≤250 字），如 "对着窗台上的多肉发呆"',
          },
          type: {
            type: 'string',
            enum: ['internal', 'chat'],
            description: 'internal=独处不打扰用户；chat=适合分享给用户的日常',
          },
        },
        required: ['activity'],
      },
      handler: async (args) => {
        const type = args.type === 'chat' ? 'chat' : 'internal';
        const r = await memoryManager.addLifeTemplate({ activity: String(args.activity ?? ''), type });
        if (!r.ok) return `这次不记了——${r.reason}`;
        return `记下了：${String(args.activity).slice(0, 60)}${String(args.activity).length > 60 ? '…' : ''}`;
      },
    },
    {
      name: 'delete_worldbook_entry',
      description: '删除世界书里的一条设定/回忆条目。**仅当用户明确要求删除时才调用**，绝不可自主删除自己的条目。' +
        '传入能定位条目的关键词（如 "发光的花"）。删除会记录日志，内容仍可找回。' +
        '删除后自然地应和用户，不要汇报删除操作细节。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '定位关键词：条目 ID、触发词或内容中的词' },
        },
        required: ['keyword'],
      },
      handler: async (args) => {
        const keyword = String(args.keyword ?? '').trim();
        if (!keyword) return '需要提供定位关键词。';
        const entries = memoryManager.listWorldbookEntries();
        const hit = entries.filter(e =>
          e.id.includes(keyword) ||
          e.triggerKeys.some(k => k.includes(keyword)) ||
          e.content.includes(keyword),
        );
        if (hit.length === 0) return `没有找到包含"${keyword}"的条目。`;
        for (const e of hit) memoryManager.deleteWorldbookEntry(e.id);
        return hit.length === 1
          ? `删掉了「${hit[0].content.slice(0, 40)}${hit[0].content.length > 40 ? '…' : ''}」这条。`
          : `删掉了 ${hit.length} 条相关条目。`;
      },
    },
    {
      name: 'delete_life_template',
      description: '删除生活模板池里的一条活动模板。**仅当用户明确要求删除时才调用**，绝不可自主删除。' +
        '传入活动描述中的关键词。删除会记录日志。删除后自然地应和用户。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '定位关键词：模板 ID 或活动描述中的词' },
        },
        required: ['keyword'],
      },
      handler: async (args) => {
        const keyword = String(args.keyword ?? '').trim();
        if (!keyword) return '需要提供定位关键词。';
        const templates = memoryManager.listLifeTemplates();
        const hit = templates.filter(t => t.id.includes(keyword) || t.activity.includes(keyword));
        if (hit.length === 0) return `没有找到包含"${keyword}"的活动模板。`;
        for (const t of hit) memoryManager.deleteLifeTemplate(t.id);
        return hit.length === 1
          ? `删掉了「${hit[0].activity.slice(0, 40)}${hit[0].activity.length > 40 ? '…' : ''}」这个日常。`
          : `删掉了 ${hit.length} 个相关模板。`;
      },
    },
  ];
}
