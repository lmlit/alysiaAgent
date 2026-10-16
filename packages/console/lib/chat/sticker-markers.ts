/**
 * `[表情包:名字]` 标记解析 —— 聊天渲染的唯一逻辑源。
 *
 * change: `improve-sticker-system`（首版只完成**已有协议的使用闭环**）
 *
 * ## 为什么单独成模块
 *
 * 协议早就存在于 core（`llm-agent.ts` 指示模型按 `[表情包:名字]` 发），
 * 服务端也早就备好了 `/api/stickers/file/:name`（注释写着「聊天视图渲染用」），
 * **只有前端这一层从来没接** —— 用户看到的是纯文本。
 *
 * 解析里真正容易写错的是**流式**：一边收字一边渲染时，
 * `[表情包:开心` 这种**还没写完**的标记不能被当成正文显示出来
 * （那就是"破碎标记"）。这段判断必须可单测，所以与 React 组件分开。
 */

export type StickerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'sticker'; name: string }

/**
 * 完整标记。**与服务端 `qq-official.ts` 的正则保持一致**：
 * 兼容全角括号 / 全角冒号（LLM 偶发输出 `［表情包：名字］`）。
 * 两边不一致会导致"QQ 发得出去、console 渲染不出来"这种**只在一条通道上复现**的怪事。
 */
const MARKER = /[\[［]\s*表情包\s*[:：]\s*([^\]］]+?)\s*[\]］]/g

/**
 * 丢掉**结尾处**那个「还可能是标记开头」的片段（只在流式期间用）。
 *
 * 判据要**两头都收紧**：
 *   - `[表` / `[表情` / `[表情包` / `[表情包:开心` → 藏着（它正在长成标记）
 *   - `[表示同意` / `[1+1` / `[情`           → **照常显示**（它长不成标记）
 *
 * ⇒ 用「去掉空白后是不是 `表情包` 的前缀」+「是不是 `表情包:` 开头」来判，
 *   而不是"以 `[` 开头就藏"（那会把正文里的方括号吃掉）。
 */
export function stripTrailingPartialMarker(text: string): string {
  const m = /[\[［]([^\]］]*)$/.exec(text)
  if (!m) return text
  const inner = m[1].replace(/\s+/g, '')
  const couldBeMarker = inner === '' || '表情包'.startsWith(inner) || /^表情包[:：]/.test(inner)
  return couldBeMarker ? text.slice(0, m.index) : text
}

/**
 * 把正文切成「文本 / 表情包」两类片段。
 *
 * @param streaming 正在流式接收时传 `true`：结尾的**半截标记**会被丢掉，
 *                  避免用户看到 `[表情包:开` 这种破碎文本。
 *                  流结束（`false`）时一律原样解析 —— 未闭合的标记就**当正文**，
 *                  因为那时候它已经不可能是标记了。
 */
export function parseStickerMarkers(
  text: string,
  opts: { streaming?: boolean } = {},
): StickerSegment[] {
  const visible = opts.streaming ? stripTrailingPartialMarker(text) : text
  const out: StickerSegment[] = []
  let last = 0

  for (const m of visible.matchAll(MARKER)) {
    const idx = m.index ?? 0
    // 先把标记**之前**的正文推出去（无论这个标记最后要不要渲染）
    if (idx > last) out.push({ kind: 'text', text: visible.slice(last, idx) })
    const name = m[1].trim()
    // ★ 名字为空的标记（`[表情包: ]`）：**不产片段**（但上面那句正文已经保住了）。
    //   服务端 `qq-official.ts` 先把标记 `replace` 掉再 `findSticker(name)`，
    //   所以空名字在 QQ 上同样是"整条消失"。两边保持一致，
    //   免得同一条回复在两个通道上长得不一样。
    if (name) out.push({ kind: 'sticker', name })
    last = idx + m[0].length
  }
  if (last < visible.length) out.push({ kind: 'text', text: visible.slice(last) })
  return out
}
