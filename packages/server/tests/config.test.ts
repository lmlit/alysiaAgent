import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../src/config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'alysia-config-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(content: string): string {
  const p = join(tmpDir, 'config.yml');
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('loadConfig — 配置加载', () => {
  it('解析完整配置并给默认值兜底', () => {
    const p = writeConfig(`
bot:
  name: 昔涟
  ownerId: TEST_OWNER
llm:
  baseUrl: https://example.com/v1
  apiKey: test-key
  model: test-model
server:
  port: 7000
  dataDir: ./data
  workspaceDir: ./ws
`);
    const cfg = loadConfig(p);
    expect(cfg.bot.name).toBe('昔涟');
    expect(cfg.bot.ownerId).toBe('TEST_OWNER');
    expect(cfg.llm.baseUrl).toBe('https://example.com/v1');
    expect(cfg.server.port).toBe(7000);
    // 未配置的给默认值
    expect(cfg.llm.model).toBe('test-model');
    expect(cfg.features?.codeMode).toBe(false);
  });

  it('环境变量插值 ${VAR}', () => {
    process.env.TEST_LLM_KEY = 'env-key-123';
    const p = writeConfig(`
bot:
  ownerId: OWNER_1
llm:
  apiKey: \${TEST_LLM_KEY}
`);
    const cfg = loadConfig(p);
    expect(cfg.llm.apiKey).toBe('env-key-123');
    delete process.env.TEST_LLM_KEY;
  });

  it('缺省平台配置不启用', () => {
    const p = writeConfig('bot:\n  ownerId: O\n');
    const cfg = loadConfig(p);
    expect(cfg.qq).toBeUndefined();
    expect(cfg.qq_official).toBeUndefined();
    expect(cfg.telegram.token).toBe('');
  });

  it('解析 qq_official 平台配置', () => {
    const p = writeConfig(`
bot:
  ownerId: O
platforms:
  qq_official:
    app_id: "12345"
    app_secret: "secret-abc"
`);
    const cfg = loadConfig(p);
    expect(cfg.qq_official?.app_id).toBe('12345');
    expect(cfg.qq_official?.app_secret).toBe('secret-abc');
  });

  it('文件不存在时抛错', () => {
    expect(() => loadConfig(join(tmpDir, 'nope.yml'))).toThrow(/Failed to read config/);
  });
});
