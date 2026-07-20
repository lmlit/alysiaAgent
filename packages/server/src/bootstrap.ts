import { AlysiaCore } from '@alysia/core';
import { TelegramAdapter } from './adapters/telegram.js';
import { loadConfig } from './config.js';

async function main() {
  const configPath = process.env.ALYSIA_CONFIG || '/app/config.yml';
  const config = loadConfig(configPath);

  const core = new AlysiaCore({
    dbPath: `${config.server.dataDir}/alysia.db`,
    ownerId: config.bot.ownerId,
    llmConfig: config.llm,
    embedConfig: config.embed,
  });

  // Register platforms
  const telegram = new TelegramAdapter(config.telegram, 'telegram-1');
  core.registerPlatform('telegram::private', core.scheduler);

  // Start
  await core.start();
  await telegram.setEventBus(core.eventBus);
  await telegram.run();

  console.log(`[Alysia] Server started on port ${config.server.port}`);
}

main().catch((err) => {
  console.error('Failed to start Alysia:', err);
  process.exit(1);
});
