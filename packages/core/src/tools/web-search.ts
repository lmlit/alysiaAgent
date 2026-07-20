import type { ToolDefinition } from './registry.js';

export function createWebSearchTool(): ToolDefinition {
  return {
    name: 'web_search',
    description: '搜索网页并返回结果摘要',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const query = encodeURIComponent(args.query as string);
      try {
        // 使用 DuckDuckGo Instant Answer API (免费、无需 key)
        const resp = await fetch(`https://api.duckduckgo.com/?q=${query}&format=json&no_html=1`);
        const data = await resp.json() as any;
        const abstract = data.AbstractText || data.Abstract || 'No results found.';
        const heading = data.Heading || '';
        const relatedTopics = (data.RelatedTopics || []).slice(0, 3)
          .map((t: any) => t.Text || '')
          .filter(Boolean);
        return [
          heading ? `**${heading}**\n${abstract}` : abstract,
          ...relatedTopics.map((t: string, i: number) => `${i + 1}. ${t}`),
        ].join('\n\n') || `No results found for "${args.query}".`;
      } catch (err: any) {
        return `Search failed: ${err.message}`;
      }
    },
  };
}
