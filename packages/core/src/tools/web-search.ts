import type { ToolDefinition } from './registry.js';

// ── 常用城市代码（中国天气网 citycode）──────────────────
const CITY_CODES: Record<string, string> = {
  '北京': '101010100', 'beijing': '101010100',
  '上海': '101020100', 'shanghai': '101020100',
  '天津': '101030100', 'tianjin': '101030100',
  '重庆': '101040100', 'chongqing': '101040100',
  '广州': '101280101', 'guangzhou': '101280101',
  '深圳': '101280601', 'shenzhen': '101280601',
  '杭州': '101210101', 'hangzhou': '101210101',
  '南京': '101190101', 'nanjing': '101190101',
  '成都': '101270101', 'chengdu': '101270101',
  '武汉': '101200101', 'wuhan': '101200101',
  '西安': '101110101', 'xian': '101110101',
  '苏州': '101190401', 'suzhou': '101190401',
  '长沙': '101250101', 'changsha': '101250101',
  '郑州': '101180101', 'zhengzhou': '101180101',
  '青岛': '101120201', 'qingdao': '101120201',
  '厦门': '101230201', 'xiamen': '101230201',
  '福州': '101230101', 'fuzhou': '101230101',
  '合肥': '101220101', 'hefei': '101220101',
  '昆明': '101290101', 'kunming': '101290101',
  '贵阳': '101260101', 'guiyang': '101260101',
  '南宁': '101300101', 'nanning': '101300101',
  '海口': '101310101', 'haikou': '101310101',
  '沈阳': '101070101', 'shenyang': '101070101',
  '大连': '101070201', 'dalian': '101070201',
  '哈尔滨': '101050101', 'haerbin': '101050101',
  '长春': '101060101', 'changchun': '101060101',
  '石家庄': '101090101', 'shijiazhuang': '101090101',
  '太原': '101100101', 'taiyuan': '101100101',
  '济南': '101120101', 'jinan': '101120101',
  '南昌': '101240101', 'nanchang': '101240101',
  '兰州': '101160101', 'lanzhou': '101160101',
  '乌鲁木齐': '101130101', 'wulumuqi': '101130101',
  '呼和浩特': '101080101', 'huhehaote': '101080101',
  '银川': '101170101', 'yinchuan': '101170101',
  '西宁': '101150101', 'xining': '101150101',
  '拉萨': '101140101', 'lasa': '101140101',
  '宁波': '101210401', 'ningbo': '101210401',
  '无锡': '101190201', 'wuxi': '101190201',
  '佛山': '101280800', 'foshan': '101280800',
  '东莞': '101281601', 'dongguan': '101281601',
  '珠海': '101280701', 'zhuhai': '101280701',
  '温州': '101210701', 'wenzhou': '101210701',
  '泉州': '101230501', 'quanzhou': '101230501',
  '洛阳': '101180901', 'luoyang': '101180901',
  '香港': '101320101', 'hongkong': '101320101',
  '澳门': '101330101', 'macau': '101330101',
  '台北': '101340101', 'taibei': '101340101',
};

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
        // ★ Bing 国内版 (cn.bing.com) — 中国大陆可直接访问（主后端）
        async () => {
          const resp = await fetch(
            `https://cn.bing.com/search?q=${query}&mkt=zh-CN`,
            { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0' } },
          );
          const html = await resp.text();
          // 解析 b_algo 结果块：标题 + 摘要
          const results: string[] = [];
          const algoRe = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?(?:<p class="b_lineclamp[^"]*">([\s\S]*?)<\/p>)?/g;
          for (const m of html.matchAll(algoRe)) {
            const title = m[2].replace(/<[^>]+>/g, '').trim();
            const snippet = (m[3] || '').replace(/<[^>]+>/g, '').replace(/&ensp;|&#0183;|&#183;|&amp;/g, ' ').trim();
            if (title) results.push(`**${title}**\n${snippet}`);
            if (results.length >= 5) break;
          }
          return results.length > 0 ? results.join('\n\n') : null;
        },
        // DuckDuckGo (海外/代理环境备用)
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

      return `抱歉，未能搜索到 "${args.query}" 的结果。请尝试用其他关键词。`;
    },
  };
}

export function createWeatherTool(): ToolDefinition {
  return {
    name: 'get_weather',
    description: '查询指定城市的当前天气。支持中文城市名或拼音（主要城市）。',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，如 "北京"、"上海"' },
      },
      required: ['city'],
    },
    handler: async (args) => {
      const cityRaw = (args.city as string || '').trim();
      const cityCode = CITY_CODES[cityRaw.toLowerCase()];
      if (!cityCode) {
        return `暂不支持该城市，支持的主要城市: ${Object.keys(CITY_CODES).filter(k => /[一-龥]/.test(k)).join('、')}。`;
      }
      try {
        // ★ 中国天气网实时天气（国内可用，无需 key）
        const resp = await fetch(
          `https://d1.weather.com.cn/sk_2d/${cityCode}.html?_=${Date.now()}`,
          { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'http://www.weather.com.cn/' } },
        );
        const text = await resp.text();
        const m = text.match(/var dataSK=(\{[^;]*\})/);
        if (!m) return `查询 "${cityRaw}" 天气失败，请稍后重试。`;
        const d = JSON.parse(m[1]);
        return `${cityRaw} 当前天气: ${d.weather}，${d.temp}°C，${d.WD}${d.WS}，湿度 ${d.SD}，能见度 ${d.njd}${d.aqi ? `，AQI ${d.aqi}` : ''}（更新 ${d.time}）`;
      } catch {
        return `查询天气失败，网络连接问题。请稍后重试。`;
      }
    },
  };
}
