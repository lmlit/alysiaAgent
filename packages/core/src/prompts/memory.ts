/**
 * 记忆链路的提示词资产（★ 2026-10-20，change: `collect-memory-prompts`，A 类重构）。
 *
 * ## 为什么有这个文件
 *
 * 在此之前，记忆链路的 4 处提示词**内联在业务代码里**（摘要 / 画像提取 / 纠错判断 /
 * 深度画像）。后果不是"不好看"，是三条：
 *   1. **改提示词要改业务文件** —— 每次都得确认自己没碰到相邻的逻辑；
 *   2. **无法集中审阅** —— 她的人格/记忆质量取决于这几段话，却分散在 3 个文件里；
 *   3. **验证脚本各自复制一份**（`server/scripts/*.ts`），改了主线就漂移。
 *
 * 对照：`core/src/persona/*.md`（人格）与 `server/src/prompts/life.ts`（生活）
 * 早就外置了 —— 记忆这一支是**漏掉的**。
 *
 * ## ★ 本文件的性质：**逐字搬移，零改动**
 *
 * 搬移前后做过**归一化比对**（剥掉引号/`+`/缩进后逐字相同），
 * 因此这是一次**行为不变**的重构 —— 任何既有测试都不需要修改。
 * ⚠️ 以后改这些提示词时：那就不再是重构，而是**行为变更**，要走 change 并说明意图。
 *
 * ## 与 sampling 槽的对应（改之前先看这里）
 *
 * | 常量 | 调用方 | 槽位 | 输出契约 |
 * |---|---|---|---|
 * | {@link SESSION_SUMMARY_SYSTEM_PROMPT} | `SessionEndProcessor` | `session.summary` | **JSON** |
 * | {@link PROFILE_EXTRACT_SYSTEM_PROMPT} | `ProfileExtractor.extract` | `profile.extract` | **JSON**（`json_object`） |
 * | {@link buildCorrectionPrompt} | `ProfileExtractor.detectCorrection` | `profile.extract` | JSON |
 * | {@link CRON_DEEP_PROFILE_SYSTEM_PROMPT} | `CronProcessor.deepProfile` | `profile.deepRewrite` | **纯文本** |
 *
 * ⚠️ 最后一条最容易踩：`deepRewrite` 与 `extract` 是**两个槽**，
 * 因为输出契约相反（纯文本 vs json_object）。合并会让其中一方直接 400。
 */

/**
 * 会话摘要（`SessionEndProcessor`）。
 *
 * ★ 8-28 角色视角（memory-character-perspective）：摘要同时总结昔涟的感受/变化
 * ★ 9-25 importance：**复用这一次调用**顺带打分——不额外增加 LLM 成本。
 *   要求返回原文摘句而不是编号：LLM 拿不到事件 id，只能靠文本匹配回填。
 */
export const SESSION_SUMMARY_SYSTEM_PROMPT =
  '你是一个会话总结器。请总结以下对话（[用户]/[昔涟] 标记发言者），提取关键主题和决定。' +
  '同时用一句话总结**昔涟**在这段对话中的感受或变化（角色视角，如"昔涟聊到雨时语气变得柔软"、"昔涟对游戏话题显得兴致勃勃"；没有明显情绪变化就留空字符串）。' +
  '另外挑出这段对话里**最值得长期记住的 1-3 处**（关系里程碑、承诺、重要偏好、情绪强烈的时刻），' +
  '每处给一个**原文摘句**（10-40 字的连续原文片段，用于回定位）和 importance（0.7-0.95 的小数，越重要越高）。' +
  '没有值得记的就返回空数组，不要硬凑。' +
  '返回JSON格式: {"summary": "...", "participants": ["user", "assistant"], "topics": [...], "key_decisions": [...], "character_perspective": "...", ' +
  '"important_moments": [{"quote": "原文摘句", "importance": 0.85}]}';

/**
 * 用户画像提取（`ProfileExtractor.extract`）。
 *
 * 逐条约束的来历都在行内注释里，**别删**——每一条都对应一次实测事故
 * （category 自由词、transient 固化、直接陈述 vs 推断）。
 */
export const PROFILE_EXTRACT_SYSTEM_PROMPT =
  '你是一个用户画像提取器。提取关于用户的事实，每条附置信度(0-1)和原文证据。' +
  'directly_stated: 用户是否直接陈述了这个事实（true=用户亲口说的，如"我周末不上班"；' +
  'false=你从对话中推断的，如"用户可能从事技术工作"）。不确定则不提取。' +
  // ★ 8-12 时效性分类（profile-transient-expiry）：瞬时事件不固化进长期画像
  'transient: 该事实是否为时效性信息（true=仅在某个时间点/短期内成立：某天吃了什么、' +
  '当天状态、单次事件、梦境、近期近况；false=稳定属性：城市/职业/习惯/偏好/关系/身体状况/长期爱好）。' +
  // ★ 8-28 分类（profile-facts-classification-confirm）：按语义判类别——
  //   identity=身份属性（城市/职业/年龄/长期状态）；preference=偏好（口味/兴趣/习惯）；
  //   status=当前状态（最近在做什么/近况）；relationship=与昔涟的关系/互动模式；general=其他稳定事实。
  //   状态类（status）过期最快（14 天），身份类最慢（365 天）——判错倾向 identity/general 保守即可。
  // ★ 8-28 修复（profile-extractor-category-fix）：LLM 实测输出 location/interest/hobby 等
  //   自由词不遵循枚举 → 全回落 general。强化约束：category 必须且只能从这五个值中选择
  'category: 必须且只能从这五个值中选择一个——"identity"(身份：城市/职业/年龄/长期状态)、"preference"(偏好：口味/兴趣/习惯/爱好)、"status"(当前状态：最近在做什么/近况)、"relationship"(与昔涟的关系/互动模式)、"general"(其他稳定事实)。' +
  // ★ 2026-10-28（resolve-fact-conflicts）：冲突判断与提取**共用同一次调用**，
  //   不额外加 LLM 成本。模型只在“同一属性、值不同”时标冲突；相关/补充不算。
  'conflicts_with: 如果这条新事实与【已有事实】里某条是同一属性但值不同（例如城市/职业/喜好/关系状态），' +
  '填那条已有事实的**原文**（必须是【已有事实】里逐字出现的一条）；只是相关、补充或更具体则填 null。' +
  '没有【已有事实】时一律 null。不要为了凑冲突而硬标。' +
  // ★ 8-28 角色视角（memory-character-perspective）：除用户事实外，同时提取对话中
  //   反映的**昔涟自己的事**（她的感受/态度/变化/习惯/看法）——结构与用户事实相同。
  //   示例："昔涟在对话中表现出对下雨的喜爱"、"昔涟最近在学做点心"。
  //   character_facts 留空数组也可以（不是每段对话都有角色事实）。
  '返回JSON: {"facts": [{"fact": "...", "confidence": 0.8, "evidence": "...", "directly_stated": true, "transient": false, "category": "preference", "conflicts_with": null}], "character_facts": [{"fact": "...", "confidence": 0.6, "evidence": "...", "category": "preference"}]}';

/**
 * 纠错判断（`ProfileExtractor.detectCorrection`）。
 *
 * 带一处插值（当前活跃事实列表），所以是函数不是常量。
 */
export function buildCorrectionPrompt(activeFacts: string): string {
  return `你是一个对话理解器。判断用户消息是否在纠正自己之前说过的事实。

当前已知的活跃事实:
${activeFacts}

如果用户在纠正，指出被纠正的事实关键词(必须能在上述列表中模糊匹配到)和新的事实内容。
如果不是纠正，返回 isCorrection: false。

返回JSON: {"isCorrection": true/false, "target": "被纠正的关键词", "newFact": "新的事实"}`;
}

/**
 * 深度画像重写（`CronProcessor.deepProfile`）。
 *
 * ⚠️ **输出是纯文本**，走 `profile.deepRewrite` 槽。若误用 `profile.extract`（含
 * `response_format: json_object`），API 会 400——因为本 prompt 里没有 "json" 字样。
 * 这正是 2026-10-01 `fix-profile-extract-empty-response` 那次事故的根因。
 */
export const CRON_DEEP_PROFILE_SYSTEM_PROMPT =
  '你是一个深度画像总结器。根据用户的所有已知事实生成一段综合画像描述。返回纯文本总结。';
