/**
 * 生活系统真实链路验证脚本（一次性）：
 * 真实 DB + 真实 LLM（DeepSeek）跑一次 LifeService.tick —— 事件生成 → post-check → 入库 → mood_value → 在场推导。
 * 不推送：maxChatPushesPerDay=0（上限即降级）且 ownerOpenid 用占位（无真实会话）。
 * 用法: PATH="/e/nodejs24:$PATH" npx tsx scripts/life-e2e-verify.ts
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env'), quiet: true });
import { AlysiaCore, DEFAULT_SAMPLING } from '@alysia/core';
import { loadConfig } from '../src/config.ts';
import { LifeService } from '../src/life.ts';

async function main() {
  const config = loadConfig(process.env.ALYSIA_CONFIG || './config.yml');
  const core = new AlysiaCore({
    dbPath: `${config.server.dataDir}/alysia.db`,
    ownerId: config.bot.ownerId,
    workspaceDir: config.server.workspaceDir,
    llmConfig: config.llm,
    embedConfig: config.embed,
    features: config.features ?? { codeMode: false },
    sampling: config.sampling,
  });
  await core.start();

  const life = new LifeService(core.memoryManager, {} as never, {
    ownerOpenid: 'verify-test-no-session',   // 占位：不真推给任何用户
    maxChatPushesPerDay: 0,                  // 上限 0 → chat 也降级不推送
    generateEvent: async (context: string) => {
      const resp = await core.providerManager.textChatWithFallback({
        prompt: context,
        sessionId: 'life-verify',
        systemPrompt:
          '你是昔涟，此刻你正过着独属于自己的生活。你是被定时任务唤醒的——这不是用户发来的消息，不要问候、不要等回复。请根据上下文生成一个此刻可能发生在你身上的生活事件（1-2 句话，第一人称）。只输出 JSON: {"content": "...", "type": "chat|internal", "mood_delta": "...", "mood_shift": 0, "reference_event_id": "...", "wb_entry_id": "...", "agency": {"can_contact": true, "reason": "..."}, "next_in_hours": 2}',
        responseFormat: 'json',
        sampling: { ...DEFAULT_SAMPLING.life.generateEvent },
      });
      return resp.role === 'assistant' ? resp.completionText : '';
    },
  });

  // 触发完整 tick（跳过推送：上限 0）
  await life.tick();

  // 验证结果
  const snap = core.memoryManager.getLifeSnapshot();
  console.log('\n===== 验证结果 =====');
  console.log('当前活动:', snap.currentActivity);
  console.log('心情:', snap.mood, '| mood_value:', snap.moodValue);
  const present = core.memoryManager.listPresentCharacters();
  console.log('在场角色:', present.length ? present.join(', ') : '(无)');
  const events = core.memoryManager.listLifeEvents(1) as Array<{ content: string; type: string; origin: string }>;
  console.log('最近事件:');
  for (const e of events.slice(-3)) console.log(`  [${e.type}${e.origin === 'followup' ? '/followup' : ''}] ${e.content.slice(0, 60)}`);
  await core.stop();
}

main().catch(err => { console.error('E2E verify failed:', err); process.exit(1); });
