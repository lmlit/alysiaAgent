'use client'

import { AppShell } from '@/components/app-shell'
import { Reveal } from '@/components/reveal'
import { PersonalityRadar } from '@/components/personality/radar'
import { ErrorBlock, LoadingBlock, NotWired } from '@/components/states'
import { useApi } from '@/lib/api/use-api'
import { personaApi } from '@/lib/api/modules'
import { formatAgo, memoryKnobs, personaDims, radarData } from '@/lib/adapt'
import { ArrowDownRight, ArrowUpRight, Brain, History, ShieldCheck } from 'lucide-react'

/**
 * 5 道护栏是 PersonaAdapter 的**设计约束**（src/memory/engines/PersonaAdapter.ts），
 * 不是可查询的运行时状态 —— 服务端没有暴露护栏状态的接口。
 * 所以这里如实展示为「设计约束」，不假装显示「正常 / 冷却中 4:12」这种实时态。
 */
const GUARDRAILS = [
  { label: '幅度限制', detail: '单次调整 |Δ| ≤ 0.1' },
  { label: '冷却时间', detail: '同一参数 5 分钟内不重复调' },
  { label: '同向上限', detail: '同方向连续调整 ≤ 3 次' },
  { label: '回归机制', detail: '24h 无强化则回落到基线' },
  { label: '显式指令', detail: '用户明确要求时绕过上述限制' },
]

export default function PersonalityPage() {
  const persona = useApi(() => personaApi.get())
  const p = persona.data

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl px-5 py-8 md:px-8 md:py-10">
        <Reveal>
          <p className="text-sm text-muted-foreground">看得见的性格</p>
          <h1 className="mt-1 font-display text-4xl md:text-5xl">
            {p?.name ? `${p.name}的人格系统` : '人格系统'}
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            语气、说话风格、情感范围——三个维度共同定义了「她是谁」。这些参数会在相处中缓慢演变，
            但始终有护栏守着，不会突变。
          </p>
        </Reveal>

        {persona.loading && (
          <div className="mt-8">
            <LoadingBlock lines={6} />
          </div>
        )}

        {!persona.loading && persona.error && (
          <ErrorBlock className="mt-8" message={persona.error} onRetry={persona.reload} />
        )}

        {!persona.loading && !persona.error && p && (
          <>
            <div className="mt-8 grid gap-5 lg:grid-cols-5">
              {/* radar */}
              <Reveal delay={80} className="lg:col-span-2">
                <section className="flex h-full flex-col items-center rounded-3xl border border-border bg-card/60 p-6">
                  <h2 className="self-start font-display text-2xl">性格雷达</h2>
                  <PersonalityRadar data={radarData(p)} />
                  <p className="mt-2 text-center text-sm text-muted-foreground">
                    当前性格的整体轮廓
                  </p>
                </section>
              </Reveal>

              {/* dimensions */}
              <Reveal delay={140} className="lg:col-span-3">
                <section className="h-full rounded-3xl border border-border bg-card/60 p-6">
                  <h2 className="font-display text-2xl">参数细项</h2>
                  <div className="mt-5 space-y-6">
                    {personaDims(p).map((dim) => (
                      <div key={dim.group}>
                        <p className="text-sm font-medium text-primary">{dim.group}</p>
                        <div className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                          {dim.params.map((param) => (
                            <div key={param.key}>
                              <div className="flex items-center justify-between text-sm">
                                <span className="text-foreground/85">{param.label}</span>
                                <span className="text-muted-foreground">
                                  {Math.round(param.value * 100)}
                                </span>
                              </div>
                              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary">
                                <div
                                  className="h-full rounded-full bg-gradient-to-r from-primary to-accent"
                                  style={{
                                    width: `${Math.max(0, Math.min(100, param.value * 100))}%`,
                                  }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </Reveal>
            </div>

            <div className="mt-6 grid gap-5 lg:grid-cols-2">
              {/* overlay notes —— 真实的稳定演化记录 */}
              <Reveal delay={120}>
                <section className="h-full rounded-3xl border border-border bg-card/60 p-6">
                  <h2 className="flex items-center gap-2 font-display text-2xl">
                    <History className="h-5 w-5 text-primary" /> 演变记录
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    她的每一次改变，都有理由，也都留有痕迹。
                  </p>

                  {p.overlayNotes.length === 0 ? (
                    <p className="mt-5 rounded-2xl bg-secondary/40 p-4 text-sm text-muted-foreground">
                      还没有固化下来的演变。短期的实时调整不在这里——只有反复出现、被确认为稳定特征的改变才会记下来。
                    </p>
                  ) : (
                    <ol className="mt-5 space-y-3">
                      {p.overlayNotes.map((n, i) => {
                        const up = n.change.includes('+')
                        return (
                          <li key={i} className="flex gap-3 rounded-2xl bg-secondary/40 p-4">
                            <div
                              className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${
                                up ? 'bg-chart-5/15 text-chart-5' : 'bg-accent/15 text-accent'
                              }`}
                            >
                              {up ? (
                                <ArrowUpRight className="h-4 w-4" />
                              ) : (
                                <ArrowDownRight className="h-4 w-4" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{n.change}</span>
                                <span className="text-xs text-muted-foreground">
                                  {n.dimension} · {formatAgo(n.appliedAt)}
                                </span>
                              </div>
                              {n.evidence && (
                                <p className="mt-1 text-sm text-muted-foreground">{n.evidence}</p>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </section>
              </Reveal>

              <div className="flex flex-col gap-5">
                {/* memory knobs */}
                <Reveal delay={160}>
                  <section className="rounded-3xl border border-border bg-card/60 p-6">
                    <h2 className="flex items-center gap-2 font-display text-2xl">
                      <Brain className="h-5 w-5 text-primary" /> 记忆参数
                    </h2>
                    <div className="mt-4 space-y-3">
                      {memoryKnobs(p.memoryConfig).map((k) => (
                        <div key={k.key}>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-foreground/85">{k.label}</span>
                            <span className="text-muted-foreground">
                              {k.signed && k.value > 0 ? '+' : ''}
                              {Math.round(k.value * 100)}%
                            </span>
                          </div>
                          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary">
                            {/* retention_bias 值域 -1..1：映射到 0..100 显示 */}
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-chart-4 to-primary"
                              style={{
                                width: `${Math.max(
                                  0,
                                  Math.min(100, k.signed ? (k.value + 1) * 50 : k.value * 100),
                                )}%`,
                              }}
                            />
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{k.hint}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                </Reveal>

                {/* guardrails */}
                <Reveal delay={200}>
                  <section className="rounded-3xl border border-border bg-card/60 p-6">
                    <h2 className="font-display text-2xl">变化护栏</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      防止性格突变，让成长始终温和可控。
                    </p>
                    <ul className="mt-4 space-y-2.5">
                      {GUARDRAILS.map((g) => (
                        <li
                          key={g.label}
                          className="flex items-center gap-3 rounded-2xl bg-secondary/40 px-4 py-3"
                        >
                          <ShieldCheck className="h-5 w-5 shrink-0 text-chart-5" />
                          <span className="text-sm">{g.label}</span>
                          <span className="ml-auto text-right text-xs text-muted-foreground">
                            {g.detail}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-4">
                      <NotWired
                        title="护栏实时状态"
                        detail="护栏在 PersonaAdapter 内部生效，服务端没有暴露查询接口。上面列出的是设计约束本身，不是实时状态。"
                      />
                    </div>
                  </section>
                </Reveal>
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
