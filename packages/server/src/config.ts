import { readFileSync } from 'fs';
import { parse } from 'yaml';

export interface ServerConfig {
  bot: { name: string; ownerId: string };
  llm: { baseUrl: string; apiKey: string; model: string };
  embed: { baseUrl: string; apiKey: string; model: string };
  telegram: { token: string };
  server: { port: number; dataDir: string; workspaceDir: string };
}

export function loadConfig(path: string): ServerConfig {
  const raw = readFileSync(path, 'utf-8');
  // 环境变量替换: ${VAR} → process.env.VAR
  const interpolated = raw.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || '');
  const data = parse(interpolated) as any;
  return {
    bot: { name: data.bot?.name ?? 'Alysia', ownerId: data.bot?.ownerId ?? '' },
    llm: {
      baseUrl: data.llm?.baseUrl ?? 'https://api.deepseek.com/v1',
      apiKey: data.llm?.apiKey ?? '',
      model: data.llm?.model ?? 'deepseek-v4-flash',
    },
    embed: {
      baseUrl: data.embed?.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: data.embed?.apiKey ?? '',
      model: data.embed?.model ?? 'embedding-2',
    },
    telegram: { token: data.platforms?.telegram?.token ?? '' },
    server: {
      port: data.server?.port ?? 6185,
      dataDir: data.server?.dataDir ?? './data',
      workspaceDir: data.server?.workspaceDir ?? './data/workspace',
    },
  };
}
