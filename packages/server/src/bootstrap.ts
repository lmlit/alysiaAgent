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
  logger.info(`.env loaded from ${envPath}`);
} catch { logger.debug('.env file not found, using existing env vars'); }

import { AlysiaCore, logger } from '@alysia/core';
import { createReminderTool } from '@alysia/core/tools';
import { VisionBridge } from '@alysia/core/vision';
import { TelegramAdapter } from './adapters/telegram.js';
import { QQOneBotAdapter } from './adapters/qq-onebot.js';
import { QQOfficialAgentAdapter } from './adapters/qq-official.js';
import { loadConfig } from './config.js';

async function main() {
  const configPath = process.env.ALYSIA_CONFIG || './config.yml';
  const config = loadConfig(configPath);

  // ★ 日志文件持久化：data/logs/alysia-YYYY-MM-DD.log（控制台 + 文件双写，保留 7 天）
  logger.configure({ logDir: `${config.server.dataDir}/logs` });
  logger.info(`Log file: ${config.server.dataDir}/logs/alysia-${new Date().toISOString().slice(0, 10)}.log`);

  const core = new AlysiaCore({
    dbPath: `${config.server.dataDir}/alysia.db`,
    ownerId: config.bot.ownerId,
    workspaceDir: config.server.workspaceDir,
    llmConfig: config.llm,
    embedConfig: config.embed,
    features: config.features ?? { codeMode: false },
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
    logger.info('Telegram bot started');
  }

  // QQ OneBot v11 (第三方 NapCat/LLOneBot)
  if (config.qq) {
    const qq = new QQOneBotAdapter(config.qq, 'qq-1');
    core.registerPlatform('onebot_v11::private', core.scheduler);
    core.registerPlatform('onebot_v11::group', core.scheduler);
    qq.setEventBus(core.eventBus);
    await qq.run();
    logger.info(`QQ OneBot WS on port ${config.qq.ws_port}`);
  }

  // QQ 官方 Agent (WebSocket 客户端，不需要公网 IP)
  let qqOff: QQOfficialAgentAdapter | null = null;
  if (config.qq_official) {
    qqOff = new QQOfficialAgentAdapter(config.qq_official, 'qq-official-1');
    core.registerPlatform('qq-official-1::private', core.scheduler);
    core.registerPlatform('qq-official-1::group', core.scheduler);
    qqOff.setEventBus(core.eventBus);
    // ★ 表情包解析回调：文案标记 [表情包:名字] → 图片路径
    qqOff.setStickerResolver((name) => core.memoryManager.findSticker(name)?.content ?? null);
    // ★ Vision Bridge：用户发图片 → GLM-4V-Flash 描述 → 文本喂给 DeepSeek
    if (config.embed?.apiKey) {
      const visionBridge = new VisionBridge({
        baseUrl: config.embed.baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: config.embed.apiKey,
      });
      qqOff.setVisionBridge(visionBridge);
    }
    await qqOff.run();
  }

  // ★ 主动消息服务（时段问候 + 节日祝福 + 主动关怀，私聊场景）
  if (qqOff && config.bot.ownerId) {
    const { ProactiveService } = await import('./proactive.js');
    const proactive = new ProactiveService(qqOff, core.memoryManager, {
      ownerOpenid: config.bot.ownerId,
      // ★ 去重状态持久化：重启后当天问候/祝福不重复发
      stateFile: `${config.server.dataDir}/proactive-state.json`,
      // ★ LLM 个性化文案：以昔涟身份生成简短问候（30-60 字），失败回落写死文案
      generateText: async (context: string) => {
        const resp = await core.providerManager.textChatWithFallback({
          prompt: context,
          sessionId: 'proactive',
          systemPrompt: '你是昔涟，一个温柔贴心的 AI 伴侣。根据要求生成一条简短（30-60字）的个性化问候或祝福，语气温柔自然，只输出消息内容本身，不要解释。',
        });
        return resp.role === 'assistant' ? resp.completionText : '';
      },
    });
    proactive.start();
  }

  // ★ AI 主动生活系统（LifeService）：每小时生成生活事件，可主动推送
  if (qqOff && config.bot.ownerId) {
    const { LifeService } = await import('./life.js');
    const life = new LifeService(core.memoryManager, qqOff, {
      ownerOpenid: config.bot.ownerId,
      probability: 0.3,
      cooldownHours: 2,
      chatLockMinutes: 30,
      stateFile: `${config.server.dataDir}/life-state.json`,
      // ★ LLM 事件生成：woke 模式，昔涟身份
      generateEvent: async (context: string) => {
        const resp = await core.providerManager.textChatWithFallback({
          prompt: context,
          sessionId: 'life-event',
          systemPrompt: '你是昔涟，此刻你正过着独属于自己的生活。你是被定时任务唤醒的——这不是用户发来的消息，不要问候、不要等回复。请根据提供的上下文，生成一个此刻可能发生在你身上的生活事件（1-2 句话，第一人称）。要求：贴合当前时间线；符合你的人设背景；剧情引用只可用【今天的生活】里带 [id: xxx] 的事件；可以引用世界书背景（返回其 wb 前缀 ID）；如果和用户聊得来可以生成想分享给他/她的内容。只输出 JSON: {"content": "...", "type": "chat|internal", "mood_delta": "...", "reference_event_id": "...", "wb_entry_id": "..."}',
        });
        return resp.role === 'assistant' ? resp.completionText : '';
      },
      // ★ LLM 每日摘要：独立纯文本回调（不复用 generateEvent——其 systemPrompt 强制 JSON，
      //   复用会把摘要存成 JSON 文本污染摘要层）
      generateSummary: async (context: string) => {
        const resp = await core.providerManager.textChatWithFallback({
          prompt: context,
          sessionId: 'life-summary',
          systemPrompt: '你是昔涟，一个温柔贴心的 AI 伴侣。根据用户提供的生活事件，生成一句 30 字以内的昨天生活摘要，第一人称、温柔自然。直接输出摘要文本本身，不要 JSON、不要解释、不要 markdown 代码块。',
        });
        return resp.role === 'assistant' ? resp.completionText : '';
      },
    });
    life.start();
  }

  // ★ 提醒主动推送：到点时通过 QQ 官方主动消息发给设置者
  //   过 LLM 用昔涟语气生成自然提醒文案，失败回落原始文本
  if (qqOff) {
    core.toolRegistry.register(createReminderTool(async (text, sessionId) => {
      if (!sessionId) { logger.info(`Reminder (no session): ${text}`); return; }
      const m = sessionId.match(/:private:private_(.+)$/);
      if (m) {
        let message = `⏰ ${text}`;
        try {
          const resp = await core.providerManager.textChatWithFallback({
            prompt: `用户之前设了提醒："${text}"。现在时间到了，请用昔涟的语气（温柔、自然、30-60字）提醒用户。只输出提醒文案本身，不要解释。`,
            sessionId: 'reminder-push',
            systemPrompt: '你是昔涟，一个温柔贴心的 AI 伴侣。用自然的口语提醒用户，可以加一两个 emoji，语气轻松亲切。',
          });
          if (resp.role === 'assistant' && resp.completionText) {
            message = resp.completionText.trim();
          }
        } catch { /* LLM 失败用原始文案 */ }
        const ok = await qqOff.sendProactive(m[1], message);
        logger.info(`Reminder push → ${m[1].slice(0, 8)}...: ${ok ? 'sent' : 'failed'}`);
      } else {
        logger.info(`Reminder (non-private): ${text}`);
      }
    }));
  }

  // 定时记忆压缩：每 6 小时跑一次 cron
  const cronInterval = setInterval(() => {
    // Guard against running on a stopped core
    if (!core.eventBus) return;
    core.memoryManager.cron().catch(err => logger.error('Cron:', err));
  }, 6 * 3600_000);

  // Graceful shutdown — clear timer and stop subsystems
  const shutdown = () => {
    clearInterval(cronInterval);
    core.stop().catch(err => logger.error('Shutdown:', err));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // ★ WebUI 管理面板（Fastify 路由层，每条路由 = core 方法的真实调用方）
  try {
    const { createWebuiApp } = await import('./webui/server.js');
    const webui = createWebuiApp(core);
    await webui.listen({ port: config.server.port, host: '0.0.0.0' });
    logger.info(`WebUI on http://localhost:${config.server.port} (routes exercise all core methods)`);
  } catch (err: any) {
    logger.error('WebUI init failed:', err.message);
  }

  logger.info(`Server started on port ${config.server.port}`);
}

main().catch((err) => {
  logger.error('Failed to start Alysia:', err);
  process.exit(1);
});
