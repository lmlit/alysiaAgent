/**
 * **看门狗通知的措辞**（★ 2026-10-19，change: `watch-for-stuck-work`，A2 档）。
 *
 * ## 为什么要她来说，而不是监控模板
 *
 * 用户的原问题：「他会**自己触发**看看卡住的进度吗」。答案分两层：
 * "会自己盯"由看门狗做（便宜、确定的判据），"说给你听"应该**是她**说 ——
 * 模板说「任务 pt-1abc 卡住 25 分钟」是运维播报；她说「那个岛海的活好像停住了，我去看了眼…」
 * 才是这个产品要的东西。
 *
 * ## 边界（这段比提示词更重要）
 *
 * - 只准说**事实里有的**（不许编"我已经处理好了"—— 看门狗是只读的，她**没有**动手）。
 * - 不许把它说成"你要我做的事"（那是系统自己盯出来的）。
 * - 不许长篇大论：这是通知，不是汇报（QQ 主动消息有配额，且用户可能正在忙）。
 *
 * 模型失败 ⇒ 返回 `null`，调用方回落**机械模板**（干，但诚实）。
 */

/** 一条"冷事实"（由 `watchdog.ts` 的纯函数算出，措辞只准用这里的内容） */
export interface WatchdogFact {
  /** 判据的稳定标识（用于去重；措辞时**不必**念出来） */
  key: string;
  level: 'warn' | 'error';
  /** 人话标题（她会改写成自己的说法） */
  title: string;
  /** 事实细节（阈值、数字、分钟数 —— 全部来自系统读数） */
  detail: string;
}

export const MAX_WATCHDOG_NOTICE_CHARS = 160;

/** 她说话的对象是人（主人），不是日志读者 */
export function buildWatchdogPrompts(input: {
  facts: WatchdogFact[];
  personaName?: string;
  recentDialogue?: string;
}): { system: string; user: string } {
  const who = input.personaName?.trim() || '昔涟';
  const system = [
    `你是「${who}」。现在你要**主动**给对方发一条很短的消息（不是回复他，是你自己发现的）。`,
    '',
    '## 你发现了什么',
    '你有一个「工程环境」，它替你干活（做页面、发布）。刚刚你自己检查了一下，发现下面这些不对劲：',
    input.facts.map(f => `- [${f.level}] ${f.title}：${f.detail}`).join('\n'),
    '',
    '## 规则（违反就是错）',
    '1. **只说事实里有的**。你没动手、也没修好任何东西 —— 不许说"我处理好了/我已经重启了"。',
    '2. 这是**你自己发现的**，不是他要你做的。别写成"你让我看的那件事"。',
    '3. 说清"哪里不对 + 多久了"，一句就够；需要他决定的，问一句就行。',
    `4. 总长 ≤ ${MAX_WATCHDOG_NOTICE_CHARS} 字，**不超过 3 句**。不要列表、不要编号、不要 markdown。`,
    '5. 语气是你平时跟他说话的样子，但别撒娇、别卖萌 —— 这是正经事。',
    '6. 结尾不要问"需要我做什么吗"这种空话；要么说清现状，要么问一个具体的选择。',
  ].join('\n');

  const user = [
    input.recentDialogue ? `## 你们最近聊的（为了语气，不必回应）\n${input.recentDialogue}` : '',
    '## 现在写这条消息',
    '直接给正文，不要「消息：」这种前缀，不要引号。',
  ].filter(Boolean).join('\n\n');

  return { system, user };
}

/** 收尾：去前缀/引号、限长；空 ⇒ `null`（调用方回落模板） */
export function finalizeWatchdogNotice(raw: string): string | null {
  let text = (raw ?? '').trim();
  if (!text) return null;
  // 模型常见的包装
  text = text.replace(/^(消息|正文|回复)\s*[:：]\s*/u, '');
  text = text.replace(/^["“「']([\s\S]*)["”」']$/u, '$1').trim();
  if (!text) return null;
  if (text.length > MAX_WATCHDOG_NOTICE_CHARS) {
    // 硬截断不好看，但比塞爆 QQ 配额强（调用方会把完整事实记进日志）
    text = `${text.slice(0, MAX_WATCHDOG_NOTICE_CHARS - 1)}…`;
  }
  return text;
}
