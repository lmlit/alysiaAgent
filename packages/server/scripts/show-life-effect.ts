/**
 * 展示生活系统重构 + digest 的实际效果：
 * ① 世界书采样注入内容（digest 优先）② 真实 LLM 生成一次生活事件（含完整 context）。
 * 用法: PATH="/e/nodejs24:$PATH" npx tsx scripts/show-life-effect.ts
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env'), quiet: true });
import { AlysiaCore, DEFAULT_SAMPLING } from '@alysia/core';
import { loadConfig } from '../src/config.ts';

async function main() {
  const config = loadConfig('./config.yml');
  const core = new AlysiaCore({
    dbPath: config.server.dataDir + '/alysia.db',
    ownerId: config.bot.ownerId,
    workspaceDir: config.server.workspaceDir,
    llmConfig: config.llm,
    embedConfig: config.embed,
    features: config.features ?? { codeMode: false },
    sampling: config.sampling,
  });
  await core.start();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('① 世界书采样（getWorldbookSample(5)：life_event 3 + text 2，digest 优先）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const sample = core.memoryManager.getWorldbookSample(5);
  for (const s of sample) {
    const len = s.content.length;
    console.log(`  [${len}字] ${s.content.replace(/\n/g, ' ').slice(0, 110)}${len > 110 ? '…' : ''}`);
  }

  // 造一个在场角色,展示【在场角色】注入
  core.memoryManager.upsertScenePresence('迷迷', 'present', '展示用');
  core.memoryManager.upsertScenePresence('白厄', 'present', '展示用');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('② 真实 LLM 生成生活事件（完整生成上下文）');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const svc = { ctx: '' };
  const resp = await core.providerManager.textChatWithFallback({
    prompt: (() => {
      const snapshot = core.memoryManager.getLifeSnapshot();
      const wbBlock = sample.map(w => `- [wb: ${w.id}] ${w.content}`).join('\n');
      const present = core.memoryManager.listPresentCharacters();
      const ctx = [
        `【当前时间】2026年8月27日 星期四 21:35`,
        `【当前状态】你正在: ${snapshot.currentActivity || '发呆'}；心情: ${snapshot.mood || '平静'}`,
        `【心情】情绪累积: +${snapshot.moodValue}（最近心情平稳）`,
        `【亲密度】与轻月: ${snapshot.intimacy}/100`,
        `【今天的生活】（还没有特别的事）`,
        `【你的人设背景】${wbBlock || '（暂无）'}`,
        `【在场角色】这些配角此刻在你身边/可互动（只与他们交集，列表外的一律不出现）：\n${present.map(n => `- ${n}`).join('\n')}`,
        `【轻月最近】（暂无）`,
        '你是被定时任务唤醒的——这不是用户发来的消息，不要问候、不要等回复。请生成一个此刻可能发生在你身上的生活事件（1-2 句话，第一人称）。只输出 JSON: {"content": "...", "type": "chat|internal", "mood_delta": "...", "mood_shift": 0, "agency": {"can_contact": true}}',
      ].join('\n');
      svc.ctx = ctx;
      return ctx;
    })(),
    sessionId: 'life-show',
    systemPrompt: '你是昔涟，此刻你正过着独属于自己的生活。',
    responseFormat: 'json',
    sampling: { ...DEFAULT_SAMPLING.life.generateEvent },
  });
  // 显示 context 的关键块(世界书 + 在场)
  console.log('\n--- 生成器收到的【你的人设背景】(digest 版) ---');
  const bg = svc.ctx.split('【你的人设背景】')[1]?.split('【在场角色】')[0];
  console.log(bg?.trim() ?? '(无)');
  console.log('\n--- 生成器收到的【在场角色】+【心情】 ---');
  const pr = svc.ctx.split('【在场角色】')[1]?.split('【轻月最近】')[0];
  const mood = svc.ctx.split('【心情】')[1]?.split('【亲密度】')[0];
  console.log('【在场角色】' + pr?.trim());
  console.log('【心情】' + mood?.trim());
  console.log('\n--- LLM 生成的事件 ---');
  console.log(resp.role === 'assistant' ? resp.completionText : '生成失败: ' + resp.completionText);

  await core.stop();
}

main().catch(e => { console.error(e); process.exit(1); });
