'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Square,
  Trash2,
} from 'lucide-react'
import { XilianAvatar } from '@/components/xilian-avatar'
import { cn } from '@/lib/utils'
import { chatApi, sessionApi } from '@/lib/api/modules'
import { StreamAbortedError, streamChat } from '@/lib/api/stream'
import type { SessionSummary } from '@/lib/api/types'

// ── localStorage 键：console 专用，不共用 webui 的 aw-chat-* ──
//   共用的话两个前端同时开着会互相覆盖当前会话（见 proposal 决策 2）
const SESSION_KEY = 'console-chat-session'
const NAMES_KEY = 'console-chat-names'

/** 服务端会话 id 是裸 id（前缀由服务端补）；统一剥干净防累积 */
const cleanSid = (id: string) => String(id ?? '').replace(/^(webui:private:)+/, '')

const THINKING_LINES = [
  '想着你刚才说的话…',
  '在心里慢慢过了一遍…',
  '歪着头想了想…',
  '轻轻唔了一声…',
]

type ChatMsg = {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** reasoning 块（不混进正文），可展开回看 */
  thought?: string
}

let seq = 0
const nextId = () => `m${++seq}-${Date.now()}`

function readSessionKey(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    console.warn('[chat] localStorage 不可读')
    return ''
  }
}

function writeSessionKey(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    console.warn('[chat] localStorage 不可写')
  }
}

function readNames(): Record<string, string> {
  try {
    return JSON.parse(readSessionKey(NAMES_KEY) || '{}')
  } catch {
    console.warn('[chat] 会话名映射解析失败，按空处理')
    return {}
  }
}

export function ChatRoom() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [currentId, setCurrentId] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [thinkingLine, setThinkingLine] = useState(THINKING_LINES[0])
  const [openThoughts, setOpenThoughts] = useState<Record<string, boolean>>({})
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [historyLoading, setHistoryLoading] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const thinkingIdx = useRef(0)

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    })
  }, [])

  const persistNames = useCallback((next: Record<string, string>) => {
    setNames(next)
    writeSessionKey(NAMES_KEY, JSON.stringify(next))
  }, [])

  const displayName = useCallback(
    (id: string) => names[id] ?? `会话 ${cleanSid(id).replace(/^sess-/, '').slice(-6)}`,
    [names],
  )

  // ── 会话列表 ──────────────────────────────────────────
  const refreshSessions = useCallback(async () => {
    try {
      const r = await sessionApi.list()
      // 只看 webui 会话（QQ/Telegram 的在这里聊不了）
      setSessions((r.sessions ?? []).filter((s) => s.sessionId.startsWith('webui:')))
    } catch (err) {
      console.error('[chat] 会话列表加载失败', err)
      setError(err instanceof Error ? err.message : '会话列表加载失败')
    }
  }, [])

  // ── 历史消息 ──────────────────────────────────────────
  const loadMessages = useCallback(
    async (id: string) => {
      if (!id) return
      setHistoryLoading(true)
      setError('')
      try {
        const r = await chatApi.messages(id, 100)
        // ★ 服务端返回时间倒序（最新在前），展示要正序
        const ordered = [...(r.messages ?? [])].reverse()
        setMessages(
          ordered.map((m) => ({
            id: nextId(),
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
          })),
        )
        scrollToBottom()
      } catch (err) {
        console.error('[chat] 历史加载失败', err)
        setError(err instanceof Error ? err.message : '历史加载失败')
      } finally {
        setHistoryLoading(false)
      }
    },
    [scrollToBottom],
  )

  // ── 初始化：恢复上次会话 ───────────────────────────────
  useEffect(() => {
    setNames(readNames())
    const saved = cleanSid(readSessionKey(SESSION_KEY))
    refreshSessions()
    if (saved) {
      setCurrentId(saved)
      void loadMessages(saved)
    }
  }, [refreshSessions, loadMessages])

  const switchSession = (id: string) => {
    if (streaming) return
    const clean = cleanSid(id)
    setCurrentId(clean)
    writeSessionKey(SESSION_KEY, clean)
    setMessages([])
    setOpenThoughts({})
    void loadMessages(clean)
  }

  const newSession = () => {
    if (streaming) return
    const id = `sess-${Date.now()}`
    setCurrentId(id)
    writeSessionKey(SESSION_KEY, id)
    setMessages([])
    setOpenThoughts({})
    setError('')
  }

  // ── 发送 ──────────────────────────────────────────────
  const send = async () => {
    const text = input.trim()
    if (!text || streaming) return

    // 首次发消息时才需要 id（服务端对未知 id 直接接受并落库，无需"新建会话"接口）
    const sid = currentId || `sess-${Date.now()}`
    if (!currentId) {
      setCurrentId(sid)
      writeSessionKey(SESSION_KEY, sid)
    }

    setInput('')
    setError('')
    setStreaming(true)
    setThinkingLine(THINKING_LINES[thinkingIdx.current++ % THINKING_LINES.length])

    const assistantId = nextId()
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: text },
      { id: assistantId, role: 'assistant', content: '' },
    ])
    scrollToBottom()

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const patch = (fn: (m: ChatMsg) => ChatMsg) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)))

    try {
      await streamChat(text, sid, {
        signal: ctrl.signal,
        onFrame: (frame) => {
          if (frame.type === 'chunk') {
            if (frame.kind === 'reasoning') {
              // ★ 思考内容进思考条，绝不混进正文
              patch((m) => ({ ...m, thought: (m.thought ?? '') + frame.text }))
            } else {
              patch((m) => ({ ...m, content: m.content + frame.text }))
              scrollToBottom()
            }
          } else if (frame.type === 'done') {
            // 流式没吐正文时退回完整回复（如走了非流式分支）
            const reply = frame.reply
            if (reply) patch((m) => (m.content ? m : { ...m, content: reply }))
            setStreaming(false)
            void refreshSessions()
          } else if (frame.type === 'aborted') {
            patch((m) => (m.content ? m : { ...m, content: '（回复被打断）' }))
            setStreaming(false)
          } else if (frame.type === 'error') {
            const message = frame.message ?? '未知错误'
            patch((m) => ({ ...m, content: `${m.content}\n\n（出错了：${message}）` }))
            setStreaming(false)
          }
        },
      })
    } catch (err) {
      if (err instanceof StreamAbortedError) {
        // 用户主动停止——不是错误，保留已收到的部分
        patch((m) => (m.content ? m : { ...m, content: '（已停止）' }))
      } else {
        const msg = err instanceof Error ? err.message : '发送失败'
        console.error('[chat] 发送失败', err)
        setError(msg)
        patch((m) => ({ ...m, content: m.content || `（发送失败：${msg}）` }))
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
      scrollToBottom()
    }
  }

  const stop = () => abortRef.current?.abort()

  // ── 重命名 / 归档 / 删除 ───────────────────────────────
  const rename = (id: string) => {
    const next = window.prompt('会话名称', names[id] ?? '')
    if (next === null) return
    const map = { ...names }
    if (next.trim()) map[id] = next.trim()
    else delete map[id]
    persistNames(map)
  }

  const confirmRemove = async (mode: 'archive' | 'delete') => {
    const id = deleteTarget
    if (!id || busy) return
    setBusy(true)
    // ★ 归档/删除路由用**原始** id 做 `startsWith('webui:')` 校验，必须带前缀。
    //   而会话列表给的是 `webui:private:<id>`、聊天路由用 cleanSid 兼容裸 id —— 契约不一致。
    //   这里显式补前缀，不依赖调用方传什么。
    const origin = `webui:private:${cleanSid(id)}`
    try {
      if (mode === 'archive') await sessionApi.archive(origin)
      else await sessionApi.remove(origin)
      const map = { ...names }
      delete map[id]
      persistNames(map)
      setDeleteTarget('')
      if (currentId === cleanSid(id)) {
        setCurrentId('')
        setMessages([])
        writeSessionKey(SESSION_KEY, '')
      }
      await refreshSessions()
    } catch (err) {
      console.error(`[chat] 会话${mode === 'archive' ? '归档' : '删除'}失败`, err)
      setError(err instanceof Error ? err.message : '操作失败')
      setDeleteTarget('')
    } finally {
      setBusy(false)
    }
  }

  const showThinkingBar = streaming && !messages.some((m) => m.role === 'assistant' && m.content)

  return (
    <div className="flex h-svh">
      {/* conversation list */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border bg-card/40 lg:flex">
        <div className="flex items-center justify-between p-4">
          <h2 className="font-display text-xl">会话</h2>
          <button
            onClick={newSession}
            disabled={streaming}
            className="flex items-center gap-1 rounded-xl border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" /> 新会话
          </button>
        </div>
        <div className="hide-scrollbar flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {sessions.length === 0 && (
            <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              还没有会话。发第一条消息就会建好。
            </p>
          )}
          {sessions.map((s) => {
            const bare = cleanSid(s.sessionId)
            const active = bare === currentId
            return (
              <button
                key={s.sessionId}
                onClick={() => switchSession(bare)}
                className={cn(
                  'w-full rounded-2xl px-3 py-3 text-left transition-colors',
                  active ? 'bg-secondary' : 'hover:bg-secondary/50',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{displayName(bare)}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {s.messageCount} 条
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {new Date(s.lastActive).toLocaleString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </button>
            )
          })}
        </div>
      </aside>

      {/* main chat */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-background/70 px-4 py-3 backdrop-blur-xl">
          <XilianAvatar size={44} intensity="soft" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{currentId ? displayName(currentId) : '新会话'}</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-chart-5" />
              <span className="truncate">{streaming ? '正在回应…' : '记忆与人格已接入'}</span>
            </p>
          </div>
          {currentId && (
            <div className="relative">
              <button
                aria-label="会话操作"
                onClick={() => setMenuOpen((v) => !v)}
                className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <MoreHorizontal className="h-5 w-5" />
              </button>
              {menuOpen && (
                <div
                  className="absolute right-0 top-11 z-20 w-40 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-xl"
                  onMouseLeave={() => setMenuOpen(false)}
                >
                  <button
                    onClick={() => {
                      rename(currentId)
                      setMenuOpen(false)
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors hover:bg-secondary"
                  >
                    <Pencil className="h-4 w-4" /> 重命名
                  </button>
                  <button
                    onClick={() => {
                      setDeleteTarget(currentId)
                      setMenuOpen(false)
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors hover:bg-secondary"
                  >
                    <Archive className="h-4 w-4" /> 归档 / 删除
                  </button>
                </div>
              )}
            </div>
          )}
        </header>

        {/* messages */}
        <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto px-4 py-6 md:px-8">
          <div className="mx-auto max-w-2xl space-y-5">
            {historyLoading && (
              <p className="text-center text-xs text-muted-foreground">正在翻出以前的对话…</p>
            )}
            {!historyLoading && messages.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                说点什么吧。她会记住的。
              </p>
            )}
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                open={!!openThoughts[m.id]}
                onToggle={() => setOpenThoughts((p) => ({ ...p, [m.id]: !p[m.id] }))}
              />
            ))}
            {showThinkingBar && <ThinkingBar line={thinkingLine} />}
          </div>
        </div>

        {error && (
          <p className="border-t border-accent/25 bg-accent/[0.08] px-4 py-2 text-xs text-foreground/80">
            {error}
          </p>
        )}

        {/* input */}
        <div className="border-t border-border bg-background/70 p-3 backdrop-blur-xl md:p-4">
          <div className="mx-auto flex max-w-2xl items-end gap-2 rounded-3xl border border-border bg-card/60 p-2 pl-4 transition-colors focus-within:border-primary/50">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={1}
              placeholder="和昔涟说点什么…"
              className="max-h-32 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground"
            />
            {streaming ? (
              <button
                aria-label="停止"
                onClick={stop}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-card text-foreground transition-all hover:scale-105"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button
                aria-label="发送"
                onClick={() => void send()}
                disabled={!input.trim()}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-all hover:scale-105 disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 归档/删除确认 */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-background/80 p-5 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-border bg-card p-6">
            <h3 className="font-display text-xl">处理这个会话</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              <span className="text-foreground/85">{displayName(cleanSid(deleteTarget))}</span>
              <br />
              <b className="text-foreground/85">归档</b>：列表里消失，数据保留。
              <br />
              <b className="text-foreground/85">删除</b>：连记忆一起清掉，不可恢复。
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button
                onClick={() => void confirmRemove('archive')}
                disabled={busy}
                className="flex items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm transition-colors hover:bg-secondary disabled:opacity-40"
              >
                <Archive className="h-4 w-4" /> 归档
              </button>
              <button
                onClick={() => void confirmRemove('delete')}
                disabled={busy}
                className="flex items-center justify-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" /> 彻底删除
              </button>
              <button
                onClick={() => setDeleteTarget('')}
                disabled={busy}
                className="rounded-xl px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MessageBubble({
  msg,
  open,
  onToggle,
}: {
  msg: ChatMsg
  open: boolean
  onToggle: () => void
}) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] whitespace-pre-wrap rounded-3xl rounded-br-lg bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-sm">
          {msg.content}
        </div>
      </div>
    )
  }
  return (
    <div className="flex gap-3">
      <XilianAvatar size={34} intensity="soft" className="mt-1 shrink-0" />
      <div className="min-w-0 max-w-[80%]">
        {msg.thought && (
          <button
            onClick={onToggle}
            className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-secondary/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
            {open ? '收起' : '她想了想'}
          </button>
        )}
        {open && msg.thought && (
          <div className="mb-1.5 whitespace-pre-wrap rounded-2xl border border-border bg-secondary/30 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
            {msg.thought}
          </div>
        )}
        {msg.content && (
          <div className="whitespace-pre-wrap rounded-3xl rounded-bl-lg border border-border bg-card px-4 py-2.5 text-sm leading-relaxed">
            {msg.content}
          </div>
        )}
      </div>
    </div>
  )
}

function ThinkingBar({ line }: { line: string }) {
  return (
    <div className="flex items-center gap-3">
      <XilianAvatar size={34} intensity="soft" className="shrink-0" />
      <div className="flex items-center gap-2 rounded-3xl rounded-bl-lg border border-border bg-card px-4 py-3">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/60"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
        <span className="text-xs text-muted-foreground">{line}</span>
      </div>
    </div>
  )
}
