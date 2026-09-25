// src/utils/llm-json.ts
// ★ 9-25 fix-session-summary-silent-failure：LLM 结构化输出的**共用解析入口**。
//
// 为什么要有这个文件：
//   "剥 markdown 围栏再 JSON.parse" 这个需求在项目里出现了两次——
//   `packages/server/src/life.ts` 和 `memory/processors/SessionEndProcessor.ts`。
//   **只做对了一处**。线上后果：会话摘要在 2026-09-04 ~ 09-25 期间 100% 失败
//   （22 天），52 条会话摘要是占位符，全部静默。
//
//   再抄一份只会把同一个问题复制一遍。所以抽成共用实现，
//   两边共用同一套行为，且这些行为有测试锁住（见 tests/utils/llm-json.test.ts）。

/**
 * 剥离 LLM 输出常见的 markdown 围栏，并 trim。
 *
 * 模型即使被要求"只输出 JSON"，仍常包一层 ```json。
 * 剥不掉就 `JSON.parse` 失败——这正是线上 `Unexpected token '`'` 的来源。
 */
export function stripMarkdownFence(raw: string | null | undefined): string {
  // 先 trim 再剥：模型常在围栏**前后带空白**，而 `^`/`$` 锚定会因此匹配不上
  // （life.ts 原版用的是单条 `/^```(?:json)?\s*|\s*```$/g`，就漏在这种输入上）。
  return String(raw ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
}

/**
 * 判断一段（已剥围栏的）文本**是否像是被截断的 JSON**。
 *
 * 判据：以 `{` / `[` 开头（说明本意是 JSON）但括号或引号未闭合。
 * 覆盖 `max_tokens` 触顶导致输出被切断的情况（线上 `Unterminated string in JSON`）。
 *
 * ⚠️ 是启发式不是解析器：它只回答"这看起来是被切断的吗"，
 * 用来**区分"模型说了句人话"和"模型话说到一半被掐了"**——这两者的处理策略不同。
 */
export function looksTruncated(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of t) {
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return depth !== 0 || inString;
}

/** 解析结果。三分支互斥，调用方必须显式处理每一种（不允许静默吞掉）。 */
export type LLMJsonResult =
  /** 成功解析出 JSON */
  | { kind: 'json'; value: any; text: string }
  /** 剥围栏后非空，但不是合法 JSON（模型返回了裸文本，或被截断） */
  | { kind: 'bare'; text: string; truncated: boolean }
  /** 剥围栏后为空（模型返回空/纯空白——线上 `Unexpected end of JSON input` 的来源） */
  | { kind: 'empty' };

/**
 * 解析 LLM 的结构化输出：剥围栏 → 空判 → JSON.parse → 裸文本兜底。
 *
 * **返回判别联合而不是抛异常**：调用方对三种情形的处理往往不同
 * （例如生活事件可以接受裸文本当正文，而会话摘要没有 JSON 就无法提取 topics，
 * 必须判失败）。把"怎么处理"留给调用方，这里只负责**如实分类**。
 */
export function parseLLMJson(raw: string | null | undefined): LLMJsonResult {
  const text = stripMarkdownFence(raw);
  if (!text) return { kind: 'empty' };
  try {
    return { kind: 'json', value: JSON.parse(text), text };
  } catch {
    return { kind: 'bare', text, truncated: looksTruncated(text) };
  }
}
