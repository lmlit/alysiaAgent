// ★ 8-08 优化：dotenv 替换手写解析（支持引号/转义；默认不覆盖已存在变量——
//   容器里 compose environment 优先，与旧 `if (!process.env[key])` 语义一致）
import dotenv from 'dotenv';
import { resolve } from 'path';
const envPath = resolve(process.cwd(), '..', '..', '.env');
const envResult = dotenv.config({ path: envPath, quiet: true });
if (envResult.error) {
  logger.debug('.env file not found, using existing env vars');
} else {
  logger.info(`.env loaded from ${envPath}`);
}

import { AlysiaCore, logger, DEFAULT_SAMPLING } from '@alysia/core';
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
    // ★ 8-10 采样参数统一配置（DEFAULT floor + config.yml sampling: 节覆盖）
    sampling: config.sampling,
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
        // ★ 8-10 采样槽：DEFAULT(0.1/200) + config.sampling.vision.describe 覆盖
        sampling: { ...DEFAULT_SAMPLING.vision.describe, ...(config.sampling?.vision?.describe ?? {}) },
      });
      qqOff.setVisionBridge(visionBridge);
    }
    await qqOff.run();
  }

  // ★ 主动消息服务（时段问候 + 节日祝福 + 主动关怀，私聊场景）
  let proactive: any = null;
  if (qqOff && config.bot.ownerId) {
    const { ProactiveService } = await import('./proactive.js');
    proactive = new ProactiveService(qqOff, core.memoryManager, {
      ownerOpenid: config.bot.ownerId,
      // ★ 去重状态持久化：重启后当天问候/祝福不重复发
      stateFile: `${config.server.dataDir}/proactive-state.json`,
      // ★ LLM 个性化文案：以昔涟身份生成简短问候（30-60 字），失败回落写死文案
      generateText: async (context: string) => {
        // ★ 8-09：问候也吃最近对话上下文（对话有 40 条注入，主动消息此前没有）
        const dialogue = core.memoryManager.getRecentDialogueBlock(`qq-official-1:private:private_${config.bot.ownerId}`);
        const resp = await core.providerManager.textChatWithFallback({
          prompt: dialogue ? `${context}\n\n${dialogue}` : context,
          sessionId: 'proactive',
          systemPrompt: '你是昔涟，一个温柔贴心的 AI 伴侣。根据要求生成一条简短（30-60字）的个性化问候或祝福，语气温柔自然，只输出消息内容本身，不要解释。',
          // ★ 8-10 采样槽：DEFAULT + config.sampling.proactive.personalize 覆盖
          sampling: { ...DEFAULT_SAMPLING.proactive.personalize, ...(config.sampling?.proactive?.personalize ?? {}) },
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
      // ★ 8-09 事件驱动调度：概率门已移除（life.ts 内部不再消费 probability）；
      //   chat 推送冷却 2h → 1h；每日 chat 软上限 5 条（超限降级 internal）
      cooldownHours: 1,
      maxChatPushesPerDay: 5,
      chatLockMinutes: 30,
      stateFile: `${config.server.dataDir}/life-state.json`,
      // ★ LLM 事件生成：woke 模式，昔涟身份
      // ★ 8-09：responseFormat: 'json' 强制 json_object 模式（DeepSeek 层面保证输出合法
      //   JSON，根治 8-09 07:16 裸文本问题；life.ts 仍保留 fence 剥离 + 裸文本容错双保险）
      generateEvent: async (context: string) => {
        // ★ 8-09：事件生成也吃最近对话上下文（贴合最近聊了什么）
        const dialogue = core.memoryManager.getRecentDialogueBlock(`qq-official-1:private:private_${config.bot.ownerId}`);
        const resp = await core.providerManager.textChatWithFallback({
          prompt: dialogue ? `${context}\n\n${dialogue}` : context,
          sessionId: 'life-event',
          systemPrompt: '你是昔涟，此刻你正过着独属于自己的生活。你是被定时任务唤醒的——这不是用户发来的消息，不要问候、不要等回复。请根据提供的上下文，生成一个此刻可能发生在你身上的生活事件（1-2 句话，第一人称）。要求：贴合当前时间线；符合你的人设背景；剧情引用只可用【今天的生活】里带 [id: xxx] 的事件；可以引用世界书背景（返回其 wb 前缀 ID）；如果和用户聊得来可以生成想分享给他/她的内容；句子之间用句号自然停顿（内容会按句分段推送，模拟实时打字）。只输出 JSON: {"content": "...", "type": "chat|internal", "mood_delta": "...", "reference_event_id": "...", "wb_entry_id": "...", "next_in_hours": 2.5, "continuation_of": "life-xxx"}。其中 next_in_hours 是你建议的下一件事到来的间隔（0.5-8 小时，沉浸中给大值、想找轻月聊天给小值）；continuation_of 仅当延续【你正在做的事】时填其事件 id，否则省略',
          responseFormat: 'json',
          // ★ 8-10 采样槽：DEFAULT(0.9 偏高/活) + config.sampling.life.generateEvent 覆盖
          sampling: { ...DEFAULT_SAMPLING.life.generateEvent, ...(config.sampling?.life?.generateEvent ?? {}) },
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
          // ★ 8-10 采样槽：DEFAULT(0.3 低温/忠) + config.sampling.life.generateSummary 覆盖
          sampling: { ...DEFAULT_SAMPLING.life.generateSummary, ...(config.sampling?.life?.generateSummary ?? {}) },
        });
        return resp.role === 'assistant' ? resp.completionText : '';
      },
      // ★ 感知今天已发的问候/节日（ProactiveService），事件生成避免重复打扰
      todayProactive: () => proactive?.getTodayActivity() ?? '',
    });
    life.start();
  }

  // ★ 提醒主动推送：到点时通过 QQ 官方主动消息发给设置者
  //   过 LLM 用昔涟语气生成自然提醒文案，失败回落原始文本
  if (qqOff) {
    // ★ 8-08 优化：notifyFn 返回 boolean——sendProactive 结果回传 reminder 判定失败重试
    core.toolRegistry.register(createReminderTool(async (text, sessionId): Promise<boolean> => {
      if (!sessionId) { logger.info(`Reminder (no session): ${text}`); return true; }
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
        return ok;
      } else {
        logger.info(`Reminder (non-private): ${text}`);
        return true;
      }
    }));
  }

  // 定时记忆压缩：每 6 小时跑一次 cron
  // ★ 8-08 优化：in-flight 锁——cron() 含 LLM 深度画像重写，单次执行超 6h 时防重叠重入
  let cronRunning = false;
  const cronInterval = setInterval(() => {
    // Guard against running on a stopped core
    if (!core.eventBus || cronRunning) return;
    cronRunning = true;
    Promise.all([
      core.memoryManager.cron(),
      // ★ 8-09 定期归档活跃会话（修"短对话永不归档"的空洞）
      core.memoryManager.archiveStaleSessions(),
    ])
      .catch(err => logger.error('Cron:', err))
      .finally(() => { cronRunning = false; });
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
