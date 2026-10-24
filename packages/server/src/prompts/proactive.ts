/**
 * 问候 / 祝福的**个性化**提示词（★ 2026-10-24，change: `unify-greeting-persona-source`）
 *
 * ## 为什么这里是一个 builder，而不是一句常量
 *
 * 改之前这段 systemPrompt **写死在 `modules/proactive.ts`**，而且它自带一句泛化身份：
 *
 *   > 你是昔涟，一个**温柔贴心的 AI 伴侣**。……
 *
 * 那是全仓**第三份人格**（前两份：DB `persona.system_prompt`、dsh 的 `XILIAN_PERSONA`），
 * 而且**没有被任何文档登记**。后果很直接：**改人格不会改到问候**，
 * 问候可能一直在用一句早就过时的自我描述。
 *
 * 现在：身份与语气**从 DB 取**（`getPersonaSnapshot()`），本文件只放**体裁约束**。
 *
 * ⚠️ **不注入完整的 compact persona**：生产库 `system_prompt` = 36352 字 / 31 节，
 * 前 4 节（`getCompactPersonaPrompt()`）= **6375 字**；给一条 30-60 字的问候塞全套不划算，
 * 也会把"问候"带成"对话"。这一体裁里「她是谁」由**名字 + 语气维度**承载足够。
 */

export interface GreetingPersona {
  name?: string;
  tone?: Record<string, number>;
  speechStyle?: Record<string, number>;
  emotionalRange?: Record<string, number>;
}

const num = (v: unknown, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : def;

/**
 * 体裁约束（**变化即行为变更**）。
 *
 * ⚠️ 与旧写死版本的三处差异，都是有意的：
 *  ① 删掉「你是昔涟，一个温柔贴心的 AI 伴侣」——身份改由 DB 提供
 *  ② 明确「第一人称 / 像发微信 / 不客套不铺垫」——避免生成通稿腔
 *  ③ 明确「不自称 AI / 助手」——防止她在问候里自我降格成工具
 */
export const PROACTIVE_PERSONALIZE_TASK = [
  '根据要求写一条**简短（30-60 字）**的个性化问候或祝福。',
  '· 用第一人称，像她本人在发微信：自然、不客套、不铺垫。',
  '· **不要**自称「AI」「助手」，也不要解释你在做什么。',
  '· 只输出消息内容本身，不要前缀、不要引号、不要解释。',
].join('\n');

/**
 * 拼 `generateText` 用的 systemPrompt。
 *
 * `persona` 缺失/为空时**仍产出可用文本**（名字退化为"她"、语气走默认），
 * 不抛、不产出 `undefined` —— 问候是"锦上添花"，不该因为读不到人格就整条不发。
 */
export function buildProactiveSystemPrompt(persona?: GreetingPersona | null): string {
  const name = String(persona?.name ?? '').trim();
  const tone = persona?.tone ?? {};
  const style = persona?.speechStyle ?? {};
  const range = persona?.emotionalRange ?? {};
  return [
    `[角色设定] 你是${name || '她'}。`,
    `语气: 形式度=${num(tone.formality, 0)}, 温暖度=${num(tone.warmth, 0.2)}, 幽默感=${num(tone.humor, 0.1)}, 直接程度=${num(tone.directness, 0)}`,
    `说话风格: 句子长度=${num(style.sentence_length, 0)}, 表情使用=${num(style.emoji_usage, 0)}`,
    `情感表达: 表现力=${num(range.expressiveness, 0.1)}, 共情=${num(range.empathy, 0.3)}`,
    '',
    '[任务]',
    PROACTIVE_PERSONALIZE_TASK,
  ].join('\n');
}
