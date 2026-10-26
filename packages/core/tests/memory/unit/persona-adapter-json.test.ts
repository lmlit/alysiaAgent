// tests/memory/unit/persona-adapter-json.test.ts
// ★ 2026-10-16 · change: `fix-persona-adapter-json-tolerance`（KI-4）
//
// 现象：`PersonaAdapter.processSignal` 用**裸 `JSON.parse`**，catch 里只写一句注释
// 「LLM returned invalid JSON, skip」就放弃 —— **无日志**。
// ⇒ 模型偶发把 JSON 包在 ```json 围栏里（很常见）时，**人格自适应静默失效**：
//   没有人格调整、也没有任何痕迹，看起来和"这轮确实不需要调整"一模一样。
//
// ★ 关键背景：这个坑**项目里已经修过一次**（`utils/llm-json.ts` 的头注）：
//   「'剥 markdown 围栏再 JSON.parse' 这个需求在项目里出现了两次——**只做对了一处**。
//     线上后果：会话摘要在 2026-09-04 ~ 09-25 期间 100% 失败（22 天）」。
//   `ProfileExtractor` / `SessionEndProcessor` 后来都换成了共用解析器
//   **只有 PersonaAdapter 还留着裸写法** —— 本 change 把它对齐。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database.js';
import { PersonaStore } from '../../../src/memory/stores/PersonaStore.js';
import { PersonaAdapter } from '../../../src/memory/engines/PersonaAdapter.js';
import { logger } from '../../../src/utils/logger.js';
import { __resetThrottledWarnings } from '../../../src/utils/write-trace.js';
import type { MemoryEvent } from '../../../src/memory/types.js';
import type { ILLMService } from '../../../src/memory/interfaces/ILLMService.js';

/** 造一条**能过信号前置过滤**的用户消息事件
 *  ⚠️ `processSignal` 第 32 行有前置过滤（`太+|能不能别|我喜欢|我讨厌|不要|别|更|再`），
 *     不含这些词的消息**根本走不到 LLM** —— 用它当输入会让断言"因为错误的理由通过"。 */
const evt = (content: string = '别那么正式'): MemoryEvent => ({
  id: `e-${Math.random().toString(36).slice(2, 8)}`,
  session_id: 'sess-pa',
  source: 'chat',
  type: 'message',
  payload: { role: 'user', content },
  importance: 0.6,
  created_at: new Date().toISOString(),
});

/** 让 LLM 返回指定原文 */
function makeAdapter(response: string) {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
    VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}',
    '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}',
    '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(now);
  const llm: ILLMService = { complete: vi.fn(async () => response) };
  const store = new PersonaStore(db);
  return { db, store, adapter: new PersonaAdapter(store, llm), llm };
}

const VALID = JSON.stringify({ adjustments: [{ param: 'tone.formality', delta: -0.05, reason: '随意些' }] });

describe('★ KI-4：PersonaAdapter 的 JSON 解析', () => {
  afterEach(() => __resetThrottledWarnings());

  it('回归：裸 JSON 照常解析出调整', async () => {
    const { db, adapter } = makeAdapter(VALID);
    try {
      const adj = await adapter.processSignal(evt('别那么正式'));
      expect(adj).toMatchObject({ param: 'tone.formality', delta: -0.05 });
    } finally { db.close(); }
  });

  it('★★ 主症：```json 围栏包着的 JSON **必须**照常解析（旧实现直接放弃）', async () => {
    const { db, adapter } = makeAdapter('```json\n' + VALID + '\n```');
    try {
      const adj = await adapter.processSignal(evt('别那么正式'));
      expect(
        adj,
        '围栏导致解析失败 ⇒ 人格自适应静默失效（模型包围栏是常见行为）',
      ).toMatchObject({ param: 'tone.formality', delta: -0.05 });
    } finally { db.close(); }
  });

  it('★ 前后带空白的围栏也要剥（`^`/`$` 锚定容易漏在这类输入上）', async () => {
    const { db, adapter } = makeAdapter('\n\n  ```json\n' + VALID + '\n```  \n\n');
    try {
      expect(await adapter.processSignal(evt('别那么正式'))).toMatchObject({ param: 'tone.formality' });
    } finally { db.close(); }
  });

  it('★★ 解析不出来时**必须留痕**（"模型说了句人话"与"自适应静默失效"不许同形）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { db, adapter } = makeAdapter('我觉得不需要调整呢。');
    try {
      const adj = await adapter.processSignal(evt('别那么正式'));
      expect(adj).toBeNull();
      expect(
        warn.mock.calls.map(c => String(c[0])).join('\n'),
        '解析失败却一声不响 —— 这正是 KI-4 藏了这么久的原因',
      ).toContain('PersonaAdapter');
    } finally { warn.mockRestore(); db.close(); }
  });

  it('★ 模型返回空串 → 同样留痕（线上 `Unexpected end of JSON input` 的来源）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { db, adapter } = makeAdapter('');
    try {
      expect(await adapter.processSignal(evt('别那么正式'))).toBeNull();
      expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('PersonaAdapter');
    } finally { warn.mockRestore(); db.close(); }
  });

  it('★ 合法的"不需要调整"（adjustments 为空数组）**不该**报成解析失败', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { db, adapter } = makeAdapter(JSON.stringify({ adjustments: [] }));
    try {
      expect(await adapter.processSignal(evt('别那么正式'))).toBeNull();
      expect(
        warn.mock.calls.map(c => String(c[0])).join('\n'),
        '空调整是**正常结果**，报 warn 会把真失败淹掉',
      ).not.toContain('PersonaAdapter');
    } finally { warn.mockRestore(); db.close(); }
  });

  it('★ 字段不合法的 JSON → 返回 null 且**不**留痕（是"乖 JSON 但内容不对"，不是解析失败）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { db, adapter } = makeAdapter(JSON.stringify({ adjustments: [{ param: 1, delta: 'x' }] }));
    try {
      expect(await adapter.processSignal(evt('别那么正式'))).toBeNull();
      expect(warn.mock.calls.map(c => String(c[0])).join('\n')).not.toContain('PersonaAdapter');
    } finally { warn.mockRestore(); db.close(); }
  });
});
