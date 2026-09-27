/**
 * 记忆派生物回填（占位符摘要 + 缺失向量）
 *
 * change: backfill-failed-session-summaries
 *
 * 2026-09-27 摸清的缺口（生产库实测）：
 *   ① 52 条占位符摘要（`summary LIKE 'Session %summary'`）—— 各有独立窗口，可重摘要
 *   ② 40 条垃圾 conversation 向量（文本是占位符）—— 随 ① 重建时替换
 *   ③ 79 条 message 事件没有向量 —— 集中在首周（7-26~7-30 占 84%），最近一次是 9-09
 *      （**不是活跃 bug**：最近 18 天零丢失。属早期管线未接好时的历史空洞）
 *
 * 设计要点：
 *   - 窗口两端都下推 SQL：`[上一条会话的 ended_at, 本条 ended_at]`。只约束下界的话，
 *     长会话里近期事件会占满 LIMIT 把老窗口挤出去（同 fix-session-event-window-truncation 的坑）。
 *   - **默认 dry-run**，必须显式 `--apply` 才写库。
 *   - 幂等：重摘要是"就地更新 + 状态翻 ok"，补向量是 upsert 语义；重跑结果一致。
 *
 * 用法（**在容器内跑**，env 由 compose 注入）：
 *   docker exec alysia-server sh -c 'cd /app/packages/core && node /path/to/backfill-memory.cjs'
 *   # 真跑加 --apply
 */
const D = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.ALYSIA_DB || '/app/data/alysia.db';
const LANCE_PATH = '/app/data/workspace/lancedb';
const PLACEHOLDER = /^Session .+ summary$/;

// ── 真实 API 客户端（与 core 的构造保持一致）────────────────────────
async function llm(systemPrompt, userPrompt, sampling) {
  const body = {
    model: process.env.CHAT_MODEL,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
  };
  if (sampling) Object.assign(body, sampling);
  const r = await fetch(`${process.env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${await r.text()}`);
  return ((await r.json()).choices?.[0]?.message?.content) || '';
}

async function embed(text) {
  const r = await fetch(`${process.env.EMBED_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.EMBED_API_KEY}` },
    body: JSON.stringify({ model: process.env.EMBED_MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`Embed ${r.status}: ${await r.text()}`);
  return (await r.json()).data[0].embedding;
}

(async () => {
  const db = new D(DB_PATH);
  const lancedb = await import('@lancedb/lancedb');
  const lance = await lancedb.connect(LANCE_PATH);
  const tbl = await lance.openTable('vectors');

  console.log(`模式: ${APPLY ? '★ APPLY（写库）' : 'DRY-RUN（只读）'}`);
  console.log(`库: ${DB_PATH}\n向量库: ${LANCE_PATH}\n`);

  // ── 报告：占位符摘要的窗口 ──────────────────────────────
  const phs = db.prepare(`SELECT * FROM conversations WHERE summary LIKE 'Session %summary' ORDER BY ended_at`).all();
  const conversations = db.prepare('SELECT session_id, ended_at FROM conversations WHERE ended_at IS NOT NULL ORDER BY ended_at').all();

  /** 窗口上界 = 该会话中更早一条的 ended_at */
  function prevEnd(sessionId, endedAt) {
    let best = null;
    for (const c of conversations) {
      if (c.session_id !== sessionId) continue;
      if (c.ended_at < endedAt && (!best || c.ended_at > best)) best = c.ended_at;
    }
    return best;
  }

  console.log(`══ ① 占位符摘要回填：${phs.length} 条 ══`);
  const jobs = [];
  let empty = 0;
  for (const ph of phs) {
    const prev = prevEnd(ph.session_id, ph.ended_at);
    const since = prev ? new Date(prev) : new Date(0);
    const until = new Date(ph.ended_at);
    const rows = db.prepare(
      `SELECT id, payload FROM events WHERE session_id=? AND type='message' AND created_at>=? AND created_at<=? ORDER BY created_at`,
    ).all(ph.session_id, since.toISOString(), until.toISOString());
    const withText = rows.filter(r => { try { return !!JSON.parse(r.payload).content; } catch { return false; } });
    if (withText.length === 0) empty++;
    jobs.push({ ph, since, until, n: withText.length });
    if (jobs.length <= 8 || jobs.length > phs.length - 5) {
      console.log(`  ${ph.ended_at}  窗口 [${prev ? prev.slice(0,19) : '起点'}, ${ph.ended_at.slice(0,19)}]  ${withText.length} 条消息${withText.length === 0 ? '  ⚠️空窗口' : ''}`);
    }
  }
  console.log(`  ...（共 ${jobs.length} 个窗口，其中空窗口 ${empty} 个）`);
  console.log(`  LLM 调用预估: ${jobs.filter(j => j.n > 0).length} 次`);

  // ── 报告：缺失向量 ────────────────────────────────────
  const allVec = await tbl.query().limit(50000).toArray();
  const chatIds = new Set(allVec.filter(r => r.source === 'chat').map(r => r.id));
  const msgs = db.prepare("SELECT id, source, type, session_id, created_at, payload FROM events WHERE type='message'").all();
  const missing = msgs.filter(m => !chatIds.has(m.id));
  const garbageConv = allVec.filter(r => r.source === 'conversation' && PLACEHOLDER.test(String(r.text || '')));
  console.log(`\n══ ② 缺失向量回填：${missing.length} 条 message 事件 ══`);
  console.log(`  Embed 调用预估: ${missing.length} 次`);
  console.log(`\n══ ③ 垃圾向量：${garbageConv.length} 条 conversation（随 ① 重建替换）══`);

  if (!APPLY) {
    console.log('\n（DRY-RUN 结束，未写任何数据。加 --apply 真跑）');
    db.close();
    return;
  }

  // ── ① 重摘要 ──────────────────────────────────────────
  // SessionEndProcessor 的依赖较多；retryFailedSummary 只用到 eventStore /
  // conversationStore / llmService / embedService / vectorStore，其余给最小占位。
  const { EventStore, ConversationStore, SessionEndProcessor } = await import('/app/packages/core/dist/memory/index.js');
  const { LanceDBStore } = await import('/app/packages/core/dist/memory/stores/LanceDBStore.js');
  const { parseLLMJson } = await import('/app/packages/core/dist/utils/llm-json.js');

  const eventStore = new EventStore(db, null);
  const lanceStore = new LanceDBStore(LANCE_PATH);
  await lanceStore.initialize();
  // ⚠️ 必须把 lanceStore 传进来：`updateSummaryResult` 内部是
  //   `if (vector && this.vectorStore)` —— 传 null 的话「摘要更新了但向量不重建」，
  //   而且完全无声。2026-09-27 首次回填就踩了这个：52 条摘要全部更新成功，
  //   但 40 条垃圾向量一条没换（日志全绿）。
  const store = new ConversationStore(db, lanceStore);

  const llmService = {
    complete: async (sys, usr, sampling) => {
      const raw = await llm(sys, usr, sampling);
      // 复用权威解析器（剥围栏 + 空判）
      const r = parseLLMJson(raw);
      if (r.kind === 'json') return raw;
      throw new Error(`非 JSON（${r.kind}${r.truncated ? '/截断' : ''}）`);
    },
  };
  const processor = new SessionEndProcessor(
    eventStore, store, {}, {}, {}, {}, {}, llmService, { embed }, lanceStore,
  );

  let okSum = 0, failSum = 0;
  for (const job of jobs) {
    if (job.n === 0) continue;
    try {
      const done = await processor.retryFailedSummary(job.ph, job.since, job.until);
      if (done) okSum++; else failSum++;
      process.stdout.write(done ? '.' : 'x');
    } catch (e) {
      failSum++;
      process.stdout.write('x');
      console.log(`\n    ✗ ${job.ph.ended_at}: ${e.message}`);
    }
  }
  console.log(`\n  重摘要完成: 成功 ${okSum}，失败 ${failSum}`);

  // ── ② 补缺失向量 ──────────────────────────────────────
  let okVec = 0, failVec = 0;
  for (const m of missing) {
    let content = '';
    try { content = JSON.parse(m.payload).content || ''; } catch {}
    if (!content) continue;
    try {
      const vec = await embed(content);
      await lanceStore.insert(m.id, vec, content, {
        source: m.source, type: m.type, session_id: m.session_id, created_at: m.created_at,
      });
      okVec++;
      process.stdout.write('.');
    } catch (e) {
      failVec++;
      process.stdout.write('x');
    }
  }
  console.log(`\n  补向量完成: 成功 ${okVec}，失败 ${failVec}`);

  // ── ③ 同步 conversation 向量 ──────────────────────────
  // 摘要已修好、但向量还停在旧文本上的那些（典型场景：上一次回填
  // ConversationStore 传了 null vectorStore，导致摘要更新了向量没重建）。
  // 判据：按 conv.id 找到向量，其 text 与当前 summary 不一致（或压根没有）→ 重建。
  // 重新取一次（不能用脚本开头那份快照：①② 可能已改动向量表）
  const freshVec = await tbl.query().limit(50000).toArray();
  const vecById = new Map(freshVec.map(r => [r.id, r]));
  const convRows = db.prepare('SELECT id, session_id, ended_at, summary, topics FROM conversations').all();
  const stale = convRows.filter(c => {
    const v = vecById.get(c.id);
    return !v || String(v.text || '') !== String(c.summary || '');
  });
  console.log(`\n══ ③ 向量需同步的 conversation：${stale.length} 条 ══`);
  let okSync = 0, failSync = 0;
  for (const c of stale) {
    if (!c.summary) continue;
    try {
      const vec = await embed(c.summary);
      await lanceStore.insert(c.id, vec, c.summary, {
        source: 'conversation', topics: c.topics, session_id: c.session_id, updated_at: c.ended_at,
      });
      okSync++;
      process.stdout.write('.');
    } catch (e) {
      failSync++;
      process.stdout.write('x');
      console.log(`\n    ✗ ${c.id.slice(0, 40)}: ${e.message}`);
    }
  }
  console.log(`\n  向量同步完成: 成功 ${okSync}，失败 ${failSync}`);

  db.close();
})().catch(e => { console.error('脚本异常:', e); process.exitCode = 1; });
