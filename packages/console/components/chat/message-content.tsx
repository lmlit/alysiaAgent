'use client'

import { useState } from 'react'
import { stickerApi } from '@/lib/api/modules'
import { parseStickerMarkers } from '@/lib/chat/sticker-markers'

/**
 * 消息正文 —— 把 `[表情包:名字]` 渲染成图片。
 *
 * change: `improve-sticker-system`（首版只完成**已有协议的使用闭环**）
 *
 * ## 决策：**气泡内联**，不做独立气泡
 *
 * 未决项里有一条「聊天渲染放在哪一层」。选内联的理由：
 *   1. 标记在句子里的**位置**是有意义的（"好呀 [表情包:开心] 那我们走吧"），
 *      拆成独立气泡会把这个位置丢掉；
 *   2. 独立气泡要把一条消息拆成多条，**流式**期间条数会来回变 ——
 *      而计划明确要求"流式输出中不展示破碎标记、不重复插图"；
 *   3. 内联图片给**固定尺寸**即可不引起布局跳动（移动端最在意的就是这件事）。
 *
 * ## 回退
 *
 * 名字不在服务端清单里（模型编的名字）**或**图片加载失败 → 显示一个不起眼的
 * **名字片**，而不是破图、也不是把标记原文吐出来：
 *   - 破图会让人以为产品坏了；
 *   - 吐原文会让人以为她说了句怪话。
 *   名字片既说明了"她本来想发表情"，又不破坏句子。
 */
export function MessageContent({
  text,
  streaming = false,
  stickerNames,
}: {
  text: string
  /** 流式接收中：结尾的半截标记会被藏起来，不显示破碎文本 */
  streaming?: boolean
  /** 服务端已知的表情包名字集合；未就绪时传 `undefined`（此时不做"未知名字"判断） */
  stickerNames?: Set<string>
}) {
  const segments = parseStickerMarkers(text, { streaming })
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <StickerInline key={i} name={seg.name} known={!stickerNames || stickerNames.has(seg.name)} />
        ),
      )}
    </>
  )
}

function StickerInline({ name, known }: { name: string; known: boolean }) {
  const [failed, setFailed] = useState(false)

  if (!known || failed) {
    return (
      <span
        // 可观测：不标出来，分不清"名字不存在"与"图挂了"
        data-sticker-fallback={name}
        title={known ? '表情包图片加载失败' : '服务端没有这个表情包'}
        className="mx-0.5 inline-block rounded-md border border-border bg-secondary/50 px-1.5 py-0.5 align-middle text-[11px] leading-none text-muted-foreground"
      >
        〔{name}〕
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- 走 /api 直链，Next 的图片优化在这里用不上（同 xilian-figure）
    <img
      src={stickerApi.fileUrl(name)}
      alt={`表情包：${name}`}
      data-sticker={name}
      // 固定尺寸 + 内联：换图/加载都不引起布局跳动（移动端尤其重要）
      // max-w-full 兜住窄屏，避免把气泡撑破
      className="mx-0.5 inline-block h-20 w-20 max-w-full rounded-lg object-contain align-middle"
      onError={() => setFailed(true)}
    />
  )
}
