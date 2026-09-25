'use client'

import { Reveal } from '@/components/reveal'
import { CountUp } from '@/components/count-up'
import { XilianFigure } from '@/components/xilian-figure'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { useApi } from '@/lib/api/use-api'
import { lifeApi } from '@/lib/api/modules'
import { adaptCompanions, adaptLife, adaptLifeEvents, adaptSummaries } from '@/lib/adapt'
import { Clock, Sprout, Wand2 } from 'lucide-react'

export function LifeContent() {
  const life = useApi(() => lifeApi.get())
  const templates = useApi(() => lifeApi.templates())
  const summaries = useApi(() => lifeApi.summaries())
  const companions = useApi(() => lifeApi.companions())

  const snapshot = adaptLife(life.data?.snapshot)
  const events = adaptLifeEvents(life.data?.events ?? [])
  const summaryViews = adaptSummaries(summaries.data?.summaries)
  const companionViews = adaptCompanions(companions.data?.companions)
  // 只统计服务端真返回的模板，不填充默认值
  const allTemplates = templates.data?.templates ?? []
  const seedTemplates = allTemplates.filter((t) => t.source === 'seed')
  const selfTemplates = allTemplates.filter((t) => t.source === 'self')

  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[500px]">
        <div className="absolute left-1/2 top-0 h-[400px] w-[700px] max-w-full -translate-x-1/2 rounded-full bg-primary/10 blur-[120px] animate-drift" />
      </div>

      {/* Hero */}
      <section className="mx-auto max-w-4xl px-5 pb-10 pt-16 text-center md:pt-24">
        <div className="flex justify-center">
          {/* Live2D 优先，失败退回暖光球（模型自带 idling，不再叠 float 动画） */}
          <XilianFigure height={320} />
        </div>
        <p className="mt-6 text-sm text-muted-foreground">此刻，她正在——</p>

        {life.loading && <LoadingBlock lines={2} className="mx-auto mt-5 max-w-md" />}

        {!life.loading && life.error && (
          <ErrorBlock
            className="mx-auto mt-5 max-w-lg text-left"
            message={life.error}
            onRetry={life.reload}
          />
        )}

        {!life.loading && !life.error && (
          <>
            <h1 className="mt-2 text-balance font-display text-4xl leading-tight md:text-5xl">
              {snapshot?.currentActivity?.trim() || '（还没有记录她的近况）'}
            </h1>
            <div className="mt-7 inline-flex flex-wrap items-center justify-center gap-6 rounded-3xl border border-border bg-card/50 px-7 py-4 backdrop-blur">
              <div className="text-center">
                <p className="text-xs text-muted-foreground">心情</p>
                <p className="mt-1 font-display text-2xl text-primary">{snapshot?.mood || '—'}</p>
                {snapshot?.moodNote && (
                  <p className="mt-0.5 max-w-[10rem] truncate text-[11px] text-muted-foreground">
                    {snapshot.moodNote}
                  </p>
                )}
              </div>
              <div className="h-10 w-px bg-border" />
              <div className="text-center">
                <p className="text-xs text-muted-foreground">亲密度</p>
                <p className="mt-1 font-display text-2xl text-accent">
                  <CountUp to={snapshot?.intimacy ?? 0} duration={2000} />
                </p>
              </div>
              <div className="h-10 w-px bg-border" />
              <div className="text-center">
                <p className="text-xs text-muted-foreground">状态更新</p>
                <p className="mt-1 font-display text-lg">{snapshot?.updatedAgo || '—'}</p>
              </div>
            </div>
          </>
        )}
      </section>

      <div className="mx-auto max-w-5xl px-5 pb-20">
        {/* timeline */}
        <Reveal>
          <h2 className="font-display text-3xl">她这几天的日子</h2>
          <p className="mt-2 text-muted-foreground">像翻开她的日记本，看到她「活着」的证据。</p>
        </Reveal>

        <div className="mt-8">
          {life.loading && <LoadingBlock lines={5} />}
          {!life.loading && life.error && <ErrorBlock message={life.error} onRetry={life.reload} />}
          {!life.loading && !life.error && events.length === 0 && (
            <EmptyBlock text="最近 7 天还没有记录。等她过完今天再看。" />
          )}
          {!life.loading && !life.error && events.length > 0 && (
            <ol className="space-y-2 border-l border-border pl-6">
              {events.map((e, i) => (
                <Reveal key={e.id} delay={Math.min(i, 8) * 90} as="li" className="relative">
                  <span
                    className={`absolute -left-[26px] top-3 h-3 w-3 rounded-full ring-4 ring-background ${
                      e.type === 'share' ? 'bg-primary' : 'bg-muted-foreground/50'
                    }`}
                  />
                  <div className="rounded-2xl border border-border bg-card/50 p-4 transition-colors hover:bg-card">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" />
                      <span>
                        {e.day} · {e.time}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 ${
                          e.type === 'share' ? 'bg-primary/15 text-primary' : 'bg-secondary'
                        }`}
                      >
                        {e.type === 'share' ? '说给轻月' : '独处时光'}
                      </span>
                      {e.type === 'share' && (
                        <span className="text-[11px] opacity-70">
                          {e.delivered ? '已送达' : '未推送'}
                        </span>
                      )}
                      {e.followup && <span className="text-[11px] opacity-70">对话余波</span>}
                    </div>
                    <p className="mt-2 leading-relaxed text-foreground/90">{e.text}</p>
                  </div>
                </Reveal>
              ))}
            </ol>
          )}
        </div>

        {/* daily summaries */}
        <Reveal className="mt-16">
          <h2 className="font-display text-3xl">每日生活摘要</h2>
          <p className="mt-2 text-muted-foreground">每天结束时，她给自己的一天写一小页。</p>
        </Reveal>
        <div className="mt-6">
          {summaries.loading && <LoadingBlock lines={4} />}
          {!summaries.loading && summaries.error && (
            <ErrorBlock message={summaries.error} onRetry={summaries.reload} />
          )}
          {!summaries.loading && !summaries.error && summaryViews.length === 0 && (
            <EmptyBlock text="还没有写下的日子。等今天过完就有了。" />
          )}
          {!summaries.loading && !summaries.error && summaryViews.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {summaryViews.map((s, i) => (
                <Reveal key={s.date} delay={(i % 3) * 100}>
                  <div className="h-full rounded-2xl border border-border bg-gradient-to-br from-card to-secondary/30 p-5 transition-transform hover:-translate-y-1">
                    <p className="text-sm text-muted-foreground">{s.label}</p>
                    <p className="mt-3 leading-relaxed text-foreground/90">{s.text}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          )}
        </div>

        {/* world + pool */}
        <div className="mt-16 grid gap-6 lg:grid-cols-2">
          <Reveal>
            <section className="h-full rounded-3xl border border-border bg-card/50 p-6">
              <h2 className="font-display text-2xl">她的世界</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                配角朋友会在场或离场，她不会凭空提到不在身边的人。
              </p>
              <div className="mt-5">
                {companions.loading && <LoadingBlock lines={3} />}
                {!companions.loading && companions.error && (
                  <ErrorBlock message={companions.error} onRetry={companions.reload} />
                )}
                {!companions.loading && !companions.error && companionViews.length === 0 && (
                  <EmptyBlock text="还没有确认过在场的朋友。" />
                )}
                {!companions.loading && !companions.error && companionViews.length > 0 && (
                  <ul className="space-y-3">
                    {companionViews.map((c) => (
                      <li
                        key={c.name}
                        className="flex items-start gap-3 rounded-2xl bg-secondary/40 px-4 py-3"
                      >
                        <span className={`relative mt-1.5 flex h-2.5 w-2.5 shrink-0 ${c.present ? '' : 'opacity-40'}`}>
                          {c.present && (
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-chart-5 opacity-70" />
                          )}
                          <span
                            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                              c.present ? 'bg-chart-5' : 'bg-muted-foreground'
                            }`}
                          />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <p className="text-sm font-medium">{c.name}</p>
                            <span className="text-xs text-muted-foreground">{c.statusLabel}</span>
                            {c.updatedAgo && (
                              <span className="ml-auto text-[11px] text-muted-foreground">
                                {c.updatedAgo}
                              </span>
                            )}
                          </div>
                          {c.basis && (
                            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                              {c.basis}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </Reveal>

          <Reveal delay={120}>
            <section className="h-full rounded-3xl border border-border bg-card/50 p-6">
              <h2 className="font-display text-2xl">生活素材库</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                她的日常从这些「种子」里长出来，也会自己创造新的。
              </p>

              {templates.loading && <LoadingBlock lines={4} className="mt-5" />}
              {!templates.loading && templates.error && (
                <ErrorBlock className="mt-5" message={templates.error} onRetry={templates.reload} />
              )}

              {!templates.loading && !templates.error && (
                <>
                  <div className="mt-5">
                    <p className="flex items-center gap-2 text-sm font-medium text-primary">
                      <Sprout className="h-4 w-4" /> 种子活动
                      <span className="text-xs font-normal text-muted-foreground">
                        {seedTemplates.length}
                      </span>
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {seedTemplates.length === 0 && (
                        <span className="text-sm text-muted-foreground">暂无</span>
                      )}
                      {seedTemplates.map((t) => (
                        <span
                          key={t.id}
                          className="rounded-full border border-border bg-secondary/40 px-3 py-1.5 text-sm"
                          title={`${t.category} · 权重 ${t.weight}`}
                        >
                          {t.activity}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="mt-5">
                    <p className="flex items-center gap-2 text-sm font-medium text-accent">
                      <Wand2 className="h-4 w-4" /> 她自创的
                      <span className="text-xs font-normal text-muted-foreground">
                        {selfTemplates.length}
                      </span>
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selfTemplates.length === 0 && (
                        <span className="text-sm text-muted-foreground">还没有自创的活动</span>
                      )}
                      {selfTemplates.map((t) => (
                        <span
                          key={t.id}
                          className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-sm text-accent-foreground/90"
                          title={`${t.category} · 权重 ${t.weight}`}
                        >
                          {t.activity}
                        </span>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </section>
          </Reveal>
        </div>
      </div>
    </div>
  )
}
