/**
 * 真机验证:生活微叙事效果(life-event-micro-narrative)
 * 真实 LLM 跑 3 次事件生成,打印 context 关键块 + 生成结果。
 * 用法: PATH="/e/nodejs24:$PATH" npx tsx scripts/verify-micro-narrative.ts
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

  const systemPrompt =
    '你是昔涟，此刻你正过着独属于自己的生活。你是被定时任务唤醒的——这不是用户发来的消息，不要问候、不要等回复。' +
    '事件是一个 2-4 句的"生活切片"——有具体时辰、平凡物件、伴随小动作，可有一个小意外或转折；前因后果自然流动，拒绝纯文学意象堆砌。' +
    '只输出 JSON: {"content": "...", "type": "chat|internal", "mood_shift": 0, "can_contact": true, "next_in_hours": 2}';

  for (let round = 1; round <= 3; round++) {
    const snapshot = core.memoryManager.getLifeSnapshot();
    const wbSample = core.memoryManager.getWorldbookSample(5);
    const wbBlock = wbSample.map(w => `- [wb: ${w.id}] ${w.content}`).join('\n');
    const present = core.memoryManager.listPresentCharacters();
    const context = [
      `【当前时间】2026年8月28日 ${round === 1 ? '上午 10:15' : round === 2 ? '下午 15:40' : '深夜 23:50'}`,
      `【当前状态】你正在: ${snapshot.currentActivity || '发呆'}；心情: ${snapshot.mood || '平静'}`,
      `【心情】情绪累积: ${snapshot.moodValue}（心情平稳）`,
      `【亲密度】与轻月: ${snapshot.intimacy}/100`,
      `【今天的生活】（还没有特别的事）`,
      `【你的人设背景】${wbBlock || '（暂无）'}`,
      `【在场角色】${present.length ? present.map(n => `- ${n}`).join('\n') : '此刻只有你一个人，安安静静的——不要凭空召唤其他角色'}`,
      `【轻月最近】（暂无）`,
      round === 1 ? '' : round === 2
        ? '【你正在做的事】在阳台看书（14:00）\n优先续写推进这件事——它有什么进展、波折或变化（比如快做完了/卡住了/被别的事打断）；只有当它自然做完了，才开启一件新的事。续写时 JSON 里 continuation_of 填该事件 id，开新事则不填。'
        : '【注意】现在是深夜，夜已深了——生活节奏安静下来（可能还在忙手头的事，也可能准备睡了）。',
      '【生活切片示范】（参考这种"活人感"平实风格，不要照抄内容）\n"下午起风了，窗台的多肉被吹得晃。我起身去关窗，顺手把晾了三天没收的袜子收了——指尖碰到布料的潮意，才想起昨天忘收衣服。叠好放进柜子，又坐回沙发，茶几上那个苹果放了几天，皮有点皱了，我拿起来又放回去。"',
    ].filter(Boolean).join('\n');

    console.log(`\n━━━ 第 ${round} 轮 (${context.split('\n')[0].replace('【当前时间】', '')}) ━━━`);
    const resp = await core.providerManager.textChatWithFallback({
      prompt: context,
      sessionId: `verify-${round}`,
      systemPrompt,
      responseFormat: 'json',
      sampling: { ...DEFAULT_SAMPLING.life.generateEvent },
    });
    if (resp.role !== 'assistant') { console.log('  生成失败:', resp.completionText); continue; }
    const parsed = JSON.parse((resp.completionText || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    console.log(`  [${parsed.type}] ${parsed.content}`);
    console.log(`  字数: ${String(parsed.content ?? '').length} | continuation_of: ${parsed.continuation_of ?? '无'}`);
  }
  await core.stop();
}

main().catch(e => { console.error(e); process.exit(1); });
