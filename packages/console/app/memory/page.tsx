'use client'

/**
 * 记忆纠正（最小版）—— change: `add-memory-correction`
 *
 * 计划给首版的四条，这一页就是它们的落点：
 *   ① 查看当前**用户事实**与**角色事实** —— 两栏并列
 *   ② 查看已有的**来源**与**时间** —— 每条都显示 source / validFrom / category
 *   ③ **纠正**错误事实、使旧事实**失效** —— 行内改 / 一键作废
 *   ④ 纠正后**后续对话用新事实** —— 由 core 侧的组装契约保证，
 *      单测锁在 `packages/core/tests/memory/profile-correction.test.ts`（含
 *      「组装进 prompt 的事实块里旧事实消失」那条），这里不重复断言
 *
 * ★ 为什么单开一页而不是塞进 `/dashboard`：总览页那个事实区是**只读展示**
 *   （取 6 条 chip），纠正是**写操作**，混在一起会让"看"和"改"的边界糊掉。
 *
 * ⚠️ 首版**只支持纠正用户事实**：角色事实（`character_facts`）在这一页**只读**。
 *   `ProfileStore` 目前没有"按 key 作废角色事实"的方法 —— 那需要单独加，
 *   不要为了对齐 UI 而在前端造一个假的失效（那会让用户以为改掉了、其实没有）。
 */

import { useState } from 'react'
import { AppShell } from '@/components/app-shell'
import { Reveal } from '@/components/reveal'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { useApi } from '@/lib/api/use-api'
import { profileApi } from '@/lib/api/modules'
import { formatAgo } from '@/lib/adapt'
import type { ProfileFact } from '@/lib/api/types'
import { Check, Pencil, Trash2, X } from 'lucide-react'

export default function MemoryPage() {
  const profile = useApi(() => profileApi.getAll())
  const data = profile.data

  // 每条事实的**就地**编辑态：key 用事实原文（也是服务端定位它的依据）
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [failed, setFailed] = useState('')

  const reset = () => {
    setEditing('')
    setDraft('')
    setBusy('')
    setNotice('')
    setFailed('')
  }

  async function submitCorrect(oldFact: string) {
    const next = draft.trim()
    if (!next) {
      setFailed('新事实不能为空——不然等于只把旧的删了')
      return
    }
    setBusy(oldFact)
    setFailed('')
    try {
      const r = await profileApi.correctFact(oldFact, next)
      setNotice(
        r.superseded
          ? '改好了。旧的已作废，往后我说的是新的。'
          : // ★ 如实说：没找到旧的，但新的确实记下了 —— 不说成"失败"，也不说成"替换成功"
            '旧的没找到（可能已经被改写过），不过新的事实我记下了。',
      )
      setEditing('')
      setDraft('')
      profile.reload()
    } catch (err) {
      setFailed(err instanceof Error ? err.message : '没改成，稍后再试')
    } finally {
      setBusy('')
    }
  }

  async function submitInvalidate(fact: string) {
    setBusy(fact)
    setFailed('')
    try {
      const r = await profileApi.confirmFact(fact, false)
      setNotice(r.found ? '忘掉了。以后我不会再拿它当回事。' : '没找到这条——可能已经不在有效列表里了。')
      profile.reload()
    } catch (err) {
      setFailed(err instanceof Error ? err.message : '没忘成，稍后再试')
    } finally {
      setBusy('')
    }
  }

  const active = (fs: ProfileFact[]) => fs.filter((f) => f.status !== 'superseded')
  const superseded = (fs: ProfileFact[]) => fs.filter((f) => f.status === 'superseded')

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl px-5 py-8 md:px-8 md:py-10">
        <Reveal>
          <p className="text-sm text-muted-foreground">我记住的东西</p>
          <h1 className="mt-1 font-display text-4xl md:text-5xl">记忆</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            这里是我记着的关于你的事。记错了就告诉我，我改——改过之后，
            我往后说的就是新记的那条，不会再拿旧的当回事。
          </p>
        </Reveal>

        {notice && (
          <p className="mt-6 rounded-2xl border border-primary/30 bg-primary/[0.07] px-4 py-2.5 text-sm">
            {notice}
          </p>
        )}
        {failed && (
          <p className="mt-6 rounded-2xl border border-destructive/40 bg-destructive/[0.07] px-4 py-2.5 text-sm">
            {failed}
          </p>
        )}

        {profile.loading && <div className="mt-8"><LoadingBlock lines={4} /></div>}
        {!profile.loading && profile.error && (
          <div className="mt-8">
            <ErrorBlock message={profile.error} onRetry={profile.reload} />
          </div>
        )}

        {!profile.loading && !profile.error && data && (
          <div className="mt-8 flex flex-col gap-6">
            <FactSection
              title="关于你的事实"
              hint="她会拿这些来理解你。记错了就改。"
              items={active(data.facts)}
              empty="还没有关于你的事实。多聊几次，我会慢慢记住的。"
              {...{ editing, draft, busy, setEditing, setDraft, reset, submitCorrect, submitInvalidate }}
            />

            <FactSection
              title="关于她自己的事实"
              hint="她自己的事——这一版**只能看，还不能改**（改法需要服务端补一个方法）。"
              items={active(data.characterFacts)}
              empty="她还没写下关于自己的事实。"
              readOnly
              {...{ editing, draft, busy, setEditing, setDraft, reset, submitCorrect, submitInvalidate }}
            />

            <SupersededSection items={superseded(data.facts)} />
          </div>
        )}
      </div>
    </AppShell>
  )
}

function FactSection({
  title,
  hint,
  items,
  empty,
  readOnly = false,
  editing,
  draft,
  busy,
  setEditing,
  setDraft,
  reset,
  submitCorrect,
  submitInvalidate,
}: {
  title: string
  hint: string
  items: ProfileFact[]
  empty: string
  readOnly?: boolean
  editing: string
  draft: string
  busy: string
  setEditing: (v: string) => void
  setDraft: (v: string) => void
  reset: () => void
  submitCorrect: (oldFact: string) => void
  submitInvalidate: (fact: string) => void
}) {
  return (
    <Reveal>
      <section className="rounded-3xl border border-border bg-card/60 p-6">
        <h2 className="font-display text-2xl">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{hint}</p>

        {items.length === 0 ? (
          <div className="mt-4">
            <EmptyBlock text={empty} />
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {items.map((f) => (
              <li key={f.fact} className="rounded-2xl bg-secondary/40 p-4">
                {editing === f.fact ? (
                  <div className="flex flex-col gap-2">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                      placeholder="改成……"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitCorrect(f.fact)
                        if (e.key === 'Escape') reset()
                      }}
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => void submitCorrect(f.fact)}
                        disabled={busy === f.fact}
                        className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
                      >
                        <Check className="h-3 w-3" /> 保存
                      </button>
                      <button
                        onClick={reset}
                        className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1.5 text-xs"
                      >
                        <X className="h-3 w-3" /> 取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm leading-relaxed">{f.fact}</p>
                      {/* ★ 来源与时间：纠正页就看这个才知道该不该改 */}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {f.source === 'user' ? '你告诉我的' : '我猜的'} · {f.category} ·{' '}
                        {f.validFrom ? formatAgo(f.validFrom) : '时间未知'}
                      </p>
                    </div>
                    {!readOnly && (
                      <div className="flex shrink-0 gap-2">
                        <button
                          onClick={() => {
                            setEditing(f.fact)
                            setDraft(f.fact)
                          }}
                          className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1.5 text-xs transition-colors hover:text-foreground"
                        >
                          <Pencil className="h-3 w-3" /> 纠正
                        </button>
                        <button
                          onClick={() => void submitInvalidate(f.fact)}
                          disabled={busy === f.fact}
                          className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                        >
                          <Trash2 className="h-3 w-3" /> 忘掉
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Reveal>
  )
}

/**
 * 已作废的事实。
 *
 * ★ 为什么要有这一段：纠正**不删除**（留审计链），所以"我改掉了"这件事
 *   必须能**被看见** —— 否则用户只能相信按钮上的那句话。
 *   这也顺带回答了「旧事实真的不再被用了吗」。
 */
function SupersededSection({ items }: { items: ProfileFact[] }) {
  if (items.length === 0) return null
  return (
    <Reveal>
      <section className="rounded-3xl border border-border bg-card/40 p-6">
        <h2 className="font-display text-2xl">已经不算数的</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          改掉或忘掉的事实不会被删除（留个来路可查），但**不再用于对话**。
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {items.map((f) => (
            <li key={f.fact} className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="line-through">{f.fact}</span>
              <span className="text-xs">
                {f.validFrom ? formatAgo(f.validFrom) : ''} 起记的
              </span>
            </li>
          ))}
        </ul>
      </section>
    </Reveal>
  )
}
