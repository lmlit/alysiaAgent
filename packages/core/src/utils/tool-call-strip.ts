/**
 * 工具调用残留文本剥离
 *
 * 背景：部分模型（如 deepseek-v4-flash）在连续多轮工具调用后，偶尔会把
 * 工具调用以纯文本形式写进回复 content（`<tool_calls>` + invoke 标签），
 * 而不是走结构化的 tool_calls API 字段。若不做处理，这段伪 XML 会被
 * 当作普通文案直接发给用户。
 *
 * 用法：对最终回复文本调用 stripToolCallText()，剥离所有工具调用残留标记。
 * 注意：只应用于 LLM 回复文本，不要用于用户消息（用户可能聊到这些标签）。
 */
export function stripToolCallText(text: string): string {
  if (!text || !text.includes('<')) return text;

  let out = text
    // 完整块：工具调用容器 <tool_calls ...>...</tool_calls>
    .replace(/<tool_calls[^>]*>[\s\S]*?<\/tool_calls>/g, '')
    // 完整块：invoke 对（含 Anthropic 风格 antml: 前缀）
    .replace(/<(?:antml:)?invoke\s+name=["'][^"']*["'][^>]*>[\s\S]*?<\/(?:antml:)?invoke>/g, '')
    // 自闭合 <invoke name="..." .../>
    .replace(/<(?:antml:)?invoke\s+name=["'][^"']*["'][^>]*\/>/g, '')
    // 未闭合的 tool_calls 容器（模型输出被截断）：删到文本末尾
    .replace(/<tool_calls[^>]*>[\s\S]*$/g, '')
    // 残留的孤立标签（</tool_calls>、</invoke>、<tool_calls> 等）
    .replace(/<\/?(?:tool_calls|(?:antml:)?invoke)\b[^>]*>/g, '');

  // 清理剥离后留下的多余空行/多余空格/首尾空白
  out = out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return out;
}
