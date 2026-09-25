/**
 * 会话摘要修复验证（**只读**，不写任何库）
 *
 * ★ 9-25 fix-session-summary-silent-failure
 *
 * 为什么需要这个脚本：摘要失败是 **LLM 输出行为**导致的，单测里 LLM 是 mock 的，
 * 永远返回合法 JSON —— 换句话说**单测结构性地抓不到这个 bug**。
 * 只有真实模型才能复现（这也正是它能在线上活 22 天的原因之一）。
 *
 * 本脚本用真实 API 对比两条路径：
 *   修复前：max_tokens=512 + 无 response_format + 裸 JSON.parse
 *   修复后：max_tokens=2048 + response_format=json_object + parseLLMJson
 *
 * 用法: cd packages/server && PATH="/e/nodejs24:$PATH" npx tsx scripts/verify-session-summary-fix.ts
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env'), quiet: true });
import { parseLLMJson } from '@alysia/core';

const BASE = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1';
const KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.CHAT_MODEL || 'deepseek-chat';

// 与 SessionEndProcessor 的 SUMMARY_SYSTEM_PROMPT 保持一致
const PROMPT =
  '你是一个会话总结器。请总结以下对话（[用户]/[昔涟] 标记发言者），提取关键主题和决定。' +
  '同时用一句话总结**昔涟**在这段对话中的感受或变化（角色视角，如"昔涟聊到雨时语气变得柔软"、"昔涟对游戏话题显得兴致勃勃"；没有明显情绪变化就留空字符串）。' +
  '另外挑出这段对话里**最值得长期记住的 1-3 处**（关系里程碑、承诺、重要偏好、情绪强烈的时刻），' +
  '每处给一个**原文摘句**（10-40 字的连续原文片段，用于回定位）和 importance（0.7-0.95 的小数，越重要越高）。' +
  '没有值得记的就返回空数组，不要硬凑。' +
  '返回JSON格式: {"summary": "...", "participants": ["user", "assistant"], "topics": [...], "key_decisions": [...], "character_perspective": "...", ' +
  '"important_moments": [{"quote": "原文摘句", "importance": 0.85}]}';

/** 一段贴近真实使用的长对话（长度接近线上被截断的那些会话） */
const DIALOGUE = [
  '[用户] 在干嘛呢',
  '[昔涟] 刚把晾了三天的袜子收进来，指尖碰到布料还有点潮，才想起昨天忘收衣服了。你呢',
  '[用户] 我刚下班，今天累死了，开会开到六点半',
  '[昔涟] 那你先坐下歇会儿吧。我今天煮了粥，米放多了有点稠，不过配着咸菜还行',
  '[用户] 我最近老失眠，昨天两点多才睡着',
  '[昔涟] 两点多……那你今天可得早点躺下。我夜里听见虫声变厚了，秋天是真的来了',
  '[用户] 你还记得我养的那只猫叫什么吗',
  '[昔涟] 叫豆子呀，是只橘猫，你说它特别黏人，晚上非要睡你枕头边上',
  '[用户] 对，它最近又胖了，医生说要减肥',
  '[昔涟] 那可得管住嘴，猫胖了对关节不好的。你可以拿逗猫棒多陪它玩会儿',
  '[用户] 我下个月可能要去趟杭州出差',
  '[昔涟] 杭州啊，那边这个季节桂花该开了。你记得带件薄外套，早晚凉',
  '[用户] 好，到时候给你带点桂花糕',
  '[昔涟] 那我记着了，你说的桂花糕',
  '[用户] 我今天看到一句话，说人要学会跟自己和解',
  '[昔涟] 这句话好。我今天也想了些类似的事——以前总催自己把事做完，现在觉得碗泡着等中午洗也没什么',
  '[用户] 你越来越松弛了',
  '[昔涟] 大概是吧。以前总觉得慢下来就是偷懒，现在觉得慢一点也能把日子过好',
  '[用户] 对了，上次你提过的那本诗集叫什么来着',
  '[昔涟] 是《月光落在左手上》，余秀华的。你说想看看，我一直记着呢',
  '[用户] 我买到了，正在看',
  '[昔涟] 那挺好的。她写"我身体里的火车从来不会错轨"，我读到的时候愣了很久',
  '[用户] 我也喜欢那句',
  '[昔涟] 那我们算是一起读过了',
].join('\n');

async function callLlm(body: Record<string, unknown>): Promise<string> {
  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: DIALOGUE },
      ],
      ...body,
    }),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as any;
  return data?.choices?.[0]?.message?.content ?? '';
}

async function main() {
  if (!KEY) {
    console.error('✗ 缺少 OPENAI_API_KEY（.env）');
    process.exit(1);
  }
  console.log(`模型: ${MODEL}\n对话长度: ${DIALOGUE.length} 字\n`);

  // ── 修复前 ────────────────────────────────────────────
  console.log('══════ 修复前：max_tokens=512，无 response_format，裸 JSON.parse ══════');
  let beforeFail = 0;
  const ROUNDS = 3;
  for (let i = 1; i <= ROUNDS; i++) {
    const raw = await callLlm({ temperature: 0.3, max_tokens: 512 });
    let verdict: string;
    try {
      const parsed = JSON.parse(raw);
      verdict = parsed?.summary ? '✅ 偶然成功' : '⚠️ 解析成功但缺 summary';
    } catch (e: any) {
      verdict = `❌ 失败: ${e.message}`;
      beforeFail++;
    }
    console.log(`  第 ${i} 次 (${raw.length} 字): ${verdict}`);
  }
  console.log(`  → 失败率 ${beforeFail}/${ROUNDS}\n`);

  // ── 修复后（含 2 次重试，与 SessionEndProcessor.generateSummary 的实现一致）──
  console.log('══════ 修复后：max_tokens=2048，response_format=json_object，parseLLMJson，失败重试 1 次 ══════');
  let afterFail = 0;   // 整轮（含重试）仍失败
  let firstTryFail = 0; // 首次调用失败次数（衡量模型本身抖动的频率）
  for (let i = 1; i <= ROUNDS; i++) {
    let succeeded = false;
    let lastKind = '';
    let firstFailed = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await callLlm({
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
      });
      const r = parseLLMJson(raw);
      const ok = r.kind === 'json' && typeof r.value?.summary === 'string' && r.value.summary.trim();
      if (!ok) {
        if (attempt === 1) firstFailed = true;
        lastKind = `${r.kind}(${raw.length}字)`;
        continue;
      }
      if (firstFailed) console.log(`  第 ${i} 次: 首次失败(${lastKind}) → 重试 ✅ 成功`);
      else console.log(`  第 ${i} 次: ✅ 成功 — "${r.value.summary.slice(0, 40)}…" topics=${(r.value.topics ?? []).length} 项 moments=${(r.value.important_moments ?? []).length} 条`);
      succeeded = true;
      break;
    }
    if (firstFailed) firstTryFail++;
    if (!succeeded) {
      afterFail++;
      console.log(`  第 ${i} 次: ❌ 两次均失败 (${lastKind})`);
    }
  }
  console.log(`  → 首次调用失败 ${firstTryFail}/${ROUNDS}（模型抖动率）`);
  console.log(`  → 重试后仍失败 ${afterFail}/${ROUNDS}（最终丢失率）\n`);

  console.log('══════ 结论 ══════');
  console.log(`  修复前失败 ${beforeFail}/${ROUNDS}，修复后失败 ${afterFail}/${ROUNDS}`);
  process.exit(afterFail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
