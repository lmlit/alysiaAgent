'use client'

import { AppShell } from '@/components/app-shell'
import { XilianFigure } from '@/components/xilian-figure'
import { Reveal } from '@/components/reveal'
import { CountUp } from '@/components/count-up'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '@/components/states'
import { useApi } from '@/lib/api/use-api'
import { lifeApi, personaApi, profileApi, sessionApi, statsApi } from '@/lib/api/modules'
import {
  adaptCompanions,
  adaptLife,
  adaptLifeEvents,
  adaptProfile,
  deriveStats,
  personaDims,
} from '@/lib/adapt'
import { BookOpen, Cloud, Heart, Sparkles } from 'lucide-react'

export default function DashboardPage() {
  const life = useApi(() => lifeApi.get())
  const profile = useApi(() => profileApi.get())
  const persona = useApi(() => personaApi.get())
  const sessions = useApi(() => sessionApi.list())
  const stats = useApi(() => statsApi.get())
  const companions = useApi(() => lifeApi.companions())

  const snapshot = adaptLife(life.data?.snapshot)
  const events = adaptLifeEvents(life.data?.events ?? [])
  const prof = profile.data ? adaptProfile(profile.data) : null
  const statCards = deriveStats(sessions.data?.sessions ?? [], events.length, stats.data)
  const companionViews = adaptCompanions(companions.data?.companions)

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl px-5 py-8 md:px-8 md:py-10">
        <Reveal>
          <p className="text-sm text-muted-foreground">{greeting()}</p>
          <h1 className="mt-1 font-display text-4xl md:text-5xl">走进她的小世界</h1>
        </Reveal>

        {/* hero status */}
        <Reveal delay={100}>
          <div className="mt-8 grid gap-5 lg:grid-cols-3">
            <div className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-card to-secondary/40 p-7 lg:col-span-2">
              <div
                aria-hidden
                className="absolute -right-10 -top-10 h-52 w-52 rounded-full bg-primary/10 blur-3xl"
              />

              {life.loading && (
                <div className="relative">
                  <LoadingBlock lines={3} />
                </div>
              )}
              {!life.loading && life.error && (
                <ErrorBlock
                  className="relative"
                  message={life.error}
                  onRetry={life.reload}
                />
              )}

              {!life.loading && !life.error && (
                <div className="relative flex flex-col items-start gap-6 sm:flex-row sm:items-center">
                  <XilianFigure height={230} className="shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-chart-5" />
                      <span className="text-sm text-muted-foreground">
                        心情{snapshot?.mood || '—'} · 状态更新于 {snapshot?.updatedAgo || '—'}
                      </span>
                    </div>
                    <p className="mt-2 flex items-center gap-2 text-lg text-foreground/90">
                      <Cloud className="h-5 w-5 shrink-0 text-primary" />
                      <span className="min-w-0">{snapshot?.currentActivity || '（暂无近况）'}</span>
                    </p>
                    <div className="mt-5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <Heart className="h-4 w-4 text-accent" /> 亲密度
                        </span>
                        <span className="font-medium text-primary">{snapshot?.intimacy ?? 0}</span>
                      </div>
                      <div className="mt-2 h-2.5 w-64 max-w-full overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-primary to-accent transition-[width] duration-1000"
                          style={{ width: `${Math.max(0, Math.min(100, snapshot?.intimacy ?? 0))}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              {stats.loading && (
                <>
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="rounded-3xl border border-border bg-card/60 p-5">
                      <LoadingBlock lines={2} />
                    </div>
                  ))}
                </>
              )}
              {!stats.loading && statCards.map((s) => (
                <div key={s.key} className="rounded-3xl border border-border bg-card/60 p-5">
                  <p className="font-display text-3xl text-primary">
                    <CountUp to={s.value} />
                    {s.capped && <span className="text-lg text-muted-foreground">+</span>}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground" title={s.hint}>
                    {s.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        {(stats.error || sessions.error) && (
          <ErrorBlock
            className="mt-4"
            message={stats.error ?? sessions.error ?? ''}
            onRetry={() => {
              stats.reload()
              sessions.reload()
            }}
          />
        )}

        <div className="mt-6 grid gap-5 lg:grid-cols-3">
          {/* recent life */}
          <Reveal delay={120} className="lg:col-span-2">
            <section className="h-full rounded-3xl border border-border bg-card/60 p-6">
              <header className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 font-display text-2xl">
                  <Sparkles className="h-5 w-5 text-primary" /> 她最近的生活
                </h3>
                <span className="text-xs text-muted-foreground">近 7 天</span>
              </header>

              <div className="mt-5">
                {life.loading && <LoadingBlock lines={4} />}
                {!life.loading && life.error && (
                  <ErrorBlock message={life.error} onRetry={life.reload} />
                )}
                {!life.loading && !life.error && events.length === 0 && (
                  <EmptyBlock text="最近 7 天还没有记录。" />
                )}
                {!life.loading && !life.error && events.length > 0 && (
                  <ol className="space-y-1">
                    {events.slice(0, 6).map((e, i) => (
                      <li
                        key={e.id}
                        className="group relative flex gap-4 rounded-2xl px-3 py-3 transition-colors hover:bg-secondary/50"
                      >
                        <div className="flex flex-col items-center">
                          <span
                            className={`mt-1 h-2.5 w-2.5 rounded-full ${
                              e.type === 'share' ? 'bg-primary' : 'bg-muted-foreground/50'
                            }`}
                          />
                          {i < Math.min(events.length, 6) - 1 && (
                            <span className="mt-1 w-px flex-1 bg-border" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1 pb-2">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>
                              {e.day} · {e.time}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 ${
                                e.type === 'share'
                                  ? 'bg-primary/15 text-primary'
                                  : 'bg-secondary text-muted-foreground'
                              }`}
                            >
                              {e.type === 'share' ? '说给轻月' : '独处时光'}
                            </span>
                          </div>
                          <p className="mt-1.5 leading-relaxed text-foreground/90">{e.text}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </section>
          </Reveal>

          {/* profile + world */}
          <div className="flex flex-col gap-5">
            <Reveal delay={160}>
              <section className="rounded-3xl border border-border bg-card/60 p-6">
                <h3 className="flex items-center gap-2 font-display text-2xl">
                  <BookOpen className="h-5 w-5 text-primary" /> 她认识的你
                </h3>

                {profile.loading && <LoadingBlock lines={3} className="mt-3" />}
                {!profile.loading && profile.error && (
                  <ErrorBlock className="mt-3" message={profile.error} onRetry={profile.reload} />
                )}
                {!profile.loading && !profile.error && prof && (
                  <>
                    {prof.summary ? (
                      <p className="mt-3 text-sm leading-relaxed text-foreground/85">
                        {prof.summary}
                      </p>
                    ) : (
                      <p className="mt-3 text-sm text-muted-foreground">
                        她还没有写下关于你的概要。
                      </p>
                    )}
                    {prof.facts.length > 0 ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {prof.facts.slice(0, 6).map((f, i) => (
                          <span
                            key={i}
                            className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground"
                            title={`${f.category} · 置信度 ${f.confidence.toFixed(2)}`}
                          >
                            {f.fact}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-3 text-xs text-muted-foreground">还没有积累到事实条目。</p>
                    )}
                  </>
                )}
              </section>
            </Reveal>

            <Reveal delay={200}>
              <section className="rounded-3xl border border-border bg-card/60 p-6">
                <h3 className="font-display text-2xl">她的世界</h3>
                <div className="mt-4">
                  {companions.loading && <LoadingBlock lines={3} />}
                  {!companions.loading && companions.error && (
                    <ErrorBlock message={companions.error} onRetry={companions.reload} />
                  )}
                  {!companions.loading && !companions.error && companionViews.length === 0 && (
                    <p className="text-sm text-muted-foreground">还没有确认过在场的朋友。</p>
                  )}
                  {!companions.loading && !companions.error && companionViews.length > 0 && (
                    <ul className="space-y-3">
                      {companionViews.map((c) => (
                        <li key={c.name} className="flex items-center gap-3">
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              c.present ? 'bg-chart-5' : 'bg-muted-foreground/40'
                            }`}
                          />
                          <p className="min-w-0 flex-1 truncate text-sm">{c.name}</p>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {c.statusLabel}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            </Reveal>
          </div>
        </div>

        {/* personality */}
        <Reveal delay={140}>
          <section className="mt-6 rounded-3xl border border-border bg-card/60 p-6">
            <h3 className="font-display text-2xl">她的性格</h3>

            {persona.loading && <LoadingBlock lines={4} className="mt-5" />}
            {!persona.loading && persona.error && (
              <ErrorBlock className="mt-5" message={persona.error} onRetry={persona.reload} />
            )}
            {!persona.loading && !persona.error && persona.data && (
              <div className="mt-5 grid gap-6 md:grid-cols-3">
                {personaDims(persona.data).map((dim) => (
                  <div key={dim.group}>
                    <p className="text-sm font-medium text-primary">{dim.group}</p>
                    <div className="mt-3 space-y-3">
                      {dim.params.map((p) => (
                        <div key={p.key}>
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>{p.label}</span>
                            <span>{Math.round(p.value * 100)}</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-primary/70 to-accent/70"
                              style={{ width: `${Math.max(0, Math.min(100, p.value * 100))}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </Reveal>
      </div>
    </AppShell>
  )
}

/** 按当前时间打招呼 */
function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}
