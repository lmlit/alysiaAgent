/**
 * **她自己注意到的事**（★ 2026-10-19，change: `watch-for-stuck-work` 的设计修正）。
 *
 * ## 为什么要这个东西（用户当场纠正）
 *
 * 第一版把看门狗的结果**推送给人**，内容还是「pt-0a15a395 卡在 intent 25 分钟」这种 —
 * 用户原话：
 *
 * > 这个不是推送给我的，是告诉昔涟让她自行决策或者来找我商量的吧，
 * > 不要太多专业名词和上面数字，很奇怪啊。
 *
 * 对。**发现问题的目的是让她知道，不是让我看监控。** 她知道了才会去处理，
 * 或者用她自己的话来找我商量；而且她眼里不该出现任务 id、阶段名、分钟数、HTTP 码。
 *
 * ## 形态
 *
 * 不推送、不落库 —— 只放在进程里的一份"待她注意"清单，由 `PromptAssembler`
 * 在下一轮组装提示词时塞进 `[你刚注意到的事]` 块。她看到之后：
 * - 能处理就处理（她手上有工具）；
 * - 需要人点头的，就**用她自己的话**来问。
 *
 * 清单里的每一条都会**自然过期**（默认 6 小时）——她一直没理会，说明不重要，
 * 不该永远挂在提示词里占预算。
 */

export interface SelfNotice {
  /** 稳定标识（去重用；**不会**出现在提示词里） */
  key: string;
  /** 给她看的一句人话：无 id、无阶段名、无数字 */
  text: string;
  /** 放进去的时间（毫秒） */
  at: number;
}

/** 默认保留多久（她一直没理会就让它自然消失） */
export const SELF_NOTICE_TTL_MS = 6 * 60 * 60 * 1000;

/** 最多挂几条（再多就是噪声，也会吃 prompt 预算） */
export const MAX_SELF_NOTICES = 5;

let notices: SelfNotice[] = [];

/**
 * 用一批新发现**替换**清单（按 key 去重）。
 *
 * 语义是"现在手上有什么事需要她注意"，不是"历史上发生过什么" ——
 * 所以每轮由调用方给出全量，这里整体替换。
 */
export function setSelfNotices(next: Array<{ key: string; text: string }>, now = Date.now()): void {
  notices = next.slice(0, MAX_SELF_NOTICES).map(n => ({ key: n.key, text: n.text, at: now }));
}

/** 读清单（顺手丢掉过期的） */
export function getSelfNotices(now = Date.now()): SelfNotice[] {
  notices = notices.filter(n => now - n.at < SELF_NOTICE_TTL_MS);
  return notices;
}

export function clearSelfNotices(): void {
  notices = [];
}

/**
 * 提示词块。**空清单返回空串**（不要留一个空的标题）。
 *
 * 措辞刻意写得像"你自己留意到的"，而不是"系统告警"：
 * 她照着这个说话才不会变成运维播报。
 */
export function renderSelfNoticeBlock(list: SelfNotice[]): string {
  if (list.length === 0) return '';
  return [
    '[你刚注意到的事]',
    ...list.map(n => `- ${n.text}`),
    '',
    '这些是你自己留意的，不是别人转给你的任务：能处理就去处理；',
    '需要他点头的，用你自己的话说清是什么事、你想怎么办 —— **别说工程术语，也别念编号和时间**。',
    '要是它正挡着你手上的活，就先跟他说一声 —— 不必硬提，也别放下手里的事。',
  ].join('\n');
}
