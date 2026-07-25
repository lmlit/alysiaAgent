// Load .env from project root
import { readFileSync } from 'fs';
import { resolve } from 'path';
const envPath = resolve(process.cwd(), '..', '..', '.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
  console.log(`  [.env loaded]`);
} catch { /* .env not found */ }

import { AlysiaCore } from '@alysia/core';
import { TelegramAdapter } from './adapters/telegram.js';
import { QQOneBotAdapter } from './adapters/qq-onebot.js';
import { QQOfficialAgentAdapter } from './adapters/qq-official.js';
import { loadConfig } from './config.js';

async function main() {
  const configPath = process.env.ALYSIA_CONFIG || '/app/config.yml';
  const config = loadConfig(configPath);

  const core = new AlysiaCore({
    dbPath: `${config.server.dataDir}/alysia.db`,
    ownerId: config.bot.ownerId,
    workspaceDir: config.server.workspaceDir,
    llmConfig: config.llm,
    embedConfig: config.embed,
  });

  // Start core first (initializes eventBus, scheduler, pipeline)
  await core.start();
  core.eventBus.setDefaultScheduler(core.scheduler);

  // Telegram
  if (config.telegram?.token) {
    const telegram = new TelegramAdapter(config.telegram, 'telegram-1');
    core.registerPlatform('telegram::private', core.scheduler);
    telegram.setEventBus(core.eventBus);
    await telegram.run();
    console.log('[Alysia] Telegram bot started');
  }

  // QQ OneBot v11 (第三方 NapCat/LLOneBot)
  if (config.qq) {
    const qq = new QQOneBotAdapter(config.qq, 'qq-1');
    core.registerPlatform('onebot_v11::private', core.scheduler);
    core.registerPlatform('onebot_v11::group', core.scheduler);
    qq.setEventBus(core.eventBus);
    await qq.run();
    console.log(`[Alysia] QQ OneBot WS on :${config.qq.ws_port}`);
  }

  // QQ 官方 Agent (WebSocket 客户端，不需要公网 IP)
  if (config.qq_official) {
    const qqOff = new QQOfficialAgentAdapter(config.qq_official, 'qq-official-1');
    core.registerPlatform('qq-official-1::private', core.scheduler);
    core.registerPlatform('qq-official-1::group', core.scheduler);
    qqOff.setEventBus(core.eventBus);
    await qqOff.run();
  }

  // 定时记忆压缩：每 6 小时跑一次 cron
  setInterval(() => {
    core.memoryManager.cron().catch(err => console.error('[Cron] error:', err));
  }, 6 * 3600_000);

  console.log(`[Alysia] Server started on port ${config.server.port}`);
}

main().catch((err) => {
  console.error('Failed to start Alysia:', err);
  process.exit(1);
});
