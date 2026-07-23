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

  // QQ 官方 Agent (Webhook)
  if (config.qq_official) {
    const qqOff = new QQOfficialAgentAdapter(config.qq_official, 'qq-official-1');
    core.registerPlatform('qq_official::private', core.scheduler);
    core.registerPlatform('qq_official::group', core.scheduler);
    qqOff.setEventBus(core.eventBus);
    await qqOff.run();
    console.log(`[Alysia] QQ Official Webhook on :${config.qq_official.webhook_port}`);
  }

  console.log(`[Alysia] Server started on port ${config.server.port}`);
}

main().catch((err) => {
  console.error('Failed to start Alysia:', err);
  process.exit(1);
});
