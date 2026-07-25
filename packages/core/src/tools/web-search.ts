import type { ToolDefinition } from './registry.js';

export function createWebSearchTool(): ToolDefinition {
  return {
    name: 'web_search',
    description: '搜索网页并返回结果摘要。适用于查找实时信息、百科知识等。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const query = encodeURIComponent(args.query as string);

      // Try multiple search backends in order
      const backends = [
        // Bing (via private API, works in China)
        async () => {
          const resp = await fetch(
            `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`,
            { signal: AbortSignal.timeout(8000) },
          );
          const data = await resp.json() as any;
          const abstract = data.AbstractText || data.Abstract || '';
          const topics = (data.RelatedTopics || []).slice(0, 3)
            .map((t: any) => t.Text || '')
            .filter(Boolean);
          return [abstract, ...topics].filter(Boolean).join('\n\n');
        },
        // DDG HTML fallback
        async () => {
          const resp = await fetch(
            `https://html.duckduckgo.com/html/?q=${query}`,
            { signal: AbortSignal.timeout(8000) },
          );
          const html = await resp.text();
          const snippets: string[] = [];
          const matches = html.matchAll(/class="result__snippet">([^<]+)</g);
          for (const m of matches) {
            snippets.push(m[1].trim());
            if (snippets.length >= 3) break;
          }
          return snippets.length > 0 ? snippets.join('\n\n') : null;
        },
        // Wikipedia API
        async () => {
          const resp = await fetch(
            `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${query}&format=json&srlimit=3`,
            { signal: AbortSignal.timeout(8000) },
          );
          const data = await resp.json() as any;
          const results = data.query?.search || [];
          return results.map((r: any) => `**${r.title}**: ${r.snippet.replace(/<[^>]+>/g, '')}`).join('\n\n');
        },
      ];

      for (const backend of backends) {
        try {
          const result = await backend();
          if (result) return result;
        } catch {
          // try next
        }
      }

      return `抱歉，未能搜索到 "${args.query}" 的结果。请尝试用其他关键词，或使用 shell_exec 工具运行 curl 获取信息。`;
    },
  };
}

export function createWeatherTool(): ToolDefinition {
  return {
    name: 'get_weather',
    description: '查询指定城市的当前天气。支持中文城市名或拼音。',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，如 "北京"、"shanghai"' },
      },
      required: ['city'],
    },
    handler: async (args) => {
      const city = encodeURIComponent(args.city as string);
      try {
        // wttr.in — worldwide, no API key, plain text
        const resp = await fetch(
          `https://wttr.in/${city}?format=%C+%t+%h+%w&lang=zh`,
          { signal: AbortSignal.timeout(8000) },
        );
        const text = await resp.text();
        if (!text.trim() || text.includes('Unknown')) {
          return `未找到 "${args.city}" 的天气信息，请检查城市名。`;
        }
        return `${args.city} 当前天气: ${text.trim()}`;
      } catch {
        return `查询天气失败，网络连接问题。请稍后重试。`;
      }
    },
  };
}
