/**
 * 记忆读路径的**接缝钉死**（★ 2026-10-25，change: `pin-memory-read-seams`）
 *
 * 这个文件解决的是"code review 里发现了、但当时没改"的四个遗留项 ——
 * 它们的共同点是**都不会报错**：
 *
 * | # | 问题 | 这里怎么钉 |
 * |---|---|---|
 * | F11 | `AssembleOptions` / `AssembleReport` 没从 barrel 导出 ⇒ 包外无法声明类型 | 断言导出**存在且可用** |
 * | F7  | 世界书"注入 0 条"的告警把「全 image」和「scope 不符」混成一句、无计数 ⇒ 看得见诊断不了 | 断言两类原因的计数分别出现 |
 * | F3  | 少给 `worldbookScope` 与"库里确实没条目"在日志里同形 | 由 server 侧日志区分（见 webui/server.ts），此处钉装配层语义**不变** |
 * | F5  | 世界书排在 life/memories **之前**（预算紧时先挤掉它们）—— 这是**有记录的权衡**，不是 bug | 钉住**顺序**，防止将来被静默改掉 |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../../src/memory/database';
import { ProfileStore } from '../../../src/memory/stores/ProfileStore';
import { PersonaStore } from '../../../src/memory/stores/PersonaStore';
import { ConversationStore } from '../../../src/memory/stores/ConversationStore';
import { KnowledgeStore } from '../../../src/memory/stores/KnowledgeStore';
import { WorldbookStore } from '../../../src/memory/stores/WorldbookStore';
import { CodeContextStore } from '../../../src/memory/stores/CodeContextStore';
import {
  PromptAssembler,
  CHAT_BLOCK_POLICY,
  CODE_BLOCK_POLICY,
  worldbookSkipDiagnosis,
  type ChatBlockKey,
  type AssembleReport,
  type AssembleOptions,
} from '../../../src/memory/index';

describe('F11 —— barrel 导出面', () => {
  it('★ 选项/回执/块策略都能从 @alysia/core/memory 拿到', () => {
    // 运行时可见即可（类型导出用 satisfies 校验：编译期不通这里就红）
    const opts: AssembleOptions = { blocks: 'chat', worldbookScope: 'code' };
    const reported: AssembleReport = { text: '', dropped: [], worldbookInjected: 0 };
    expect(opts.worldbookScope).toBe('code');
    expect(reported.worldbookInjected).toBe(0);
    expect(Object.keys(CHAT_BLOCK_POLICY).length).toBeGreaterThan(10);
    expect(Object.keys(CODE_BLOCK_POLICY).length).toBe(6);
  });
});

describe('F5 —— 块顺序是行为，必须钉住', () => {
  it('★ chat 表顺序：世界书排在 recentConversations 之后、life/memories 之前', () => {
    // 顺序 = 谁先占预算。世界书长条目会挤掉 life / memories —— 这是**已知代价**
    // （见 CHAT_BLOCK_POLICY 的注释）。钉住它，是为了让"改顺序"必须显式改测试，
    // 而不是悄悄把她的相关记忆挤出去。
    const keys = Object.keys(CHAT_BLOCK_POLICY) as ChatBlockKey[];
    const iWb = keys.indexOf('worldbook');
    const iLife = keys.indexOf('life');
    const iMem = keys.indexOf('memories');
    const iRecent = keys.indexOf('recentConversations');
    expect(iWb).toBeGreaterThan(iRecent);
    expect(iWb).toBeLessThan(iLife);
    expect(iLife).toBeLessThan(iMem);
  });

  it('★ 只有 persona/selfNotice/brevity 是 required；世界书与生活都是 optional', () => {
    expect(CHAT_BLOCK_POLICY.persona).toBe('required');
    expect(CHAT_BLOCK_POLICY.selfNotice).toBe('required');
    expect(CHAT_BLOCK_POLICY.brevity).toBe('required');
    expect(CHAT_BLOCK_POLICY.worldbook).toBe('optional');
    expect(CHAT_BLOCK_POLICY.life).toBe('optional');
    expect(CHAT_BLOCK_POLICY.memories).toBe('optional');
  });
});

describe('F7 —— "注入 0 条"必须能诊断', () => {
  const wb = (id: string, over: Record<string, unknown> = {}) => ({
    id, content: `${id} 的内容`, content_type: 'text', scope: 'code', priority: 5,
    trigger_words: '', cooldown_sec: 0, created_at: new Date().toISOString(), ...over,
  }) as any;

  it('全是 image ⇒ 点名 image 条数，并指向 content_type', () => {
    const msg = worldbookSkipDiagnosis(
      [wb('a', { content_type: 'image' }), wb('b', { content_type: 'image' })], 'code',
    );
    expect(msg).toMatch(/image 型 2 条/);
    expect(msg, '要指向 content_type 配错，而不是让人去查代码').toContain('检查 content_type');
  });

  it('★ scope 不符 ⇒ 说清是「配置缺口，不是故障」', () => {
    const msg = worldbookSkipDiagnosis([wb('a', { scope: 'chat' })], 'code');
    expect(msg).toMatch(/scope 不符 1 条/);
    expect(msg, '运维看到"故障"就会去查代码 —— 必须区分').toContain('配置缺口，不是故障');
  });

  it('两类原因并存 ⇒ 明说并存，不二选一', () => {
    const msg = worldbookSkipDiagnosis(
      [wb('a', { content_type: 'image' }), wb('b', { scope: 'chat' })], 'code',
    );
    expect(msg).toMatch(/image 型 1 条/);
    expect(msg).toMatch(/scope 不符 1 条/);
    expect(msg).toContain('两类原因并存');
  });

  it('没有匹配到任何条目 ⇒ 不告警（那是"命中 0 条"，不是异常）', () => {
    expect(worldbookSkipDiagnosis([], 'code')).toBeNull();
  });
});

describe('F3 —— 不给 worldbookScope 时语义不变（不注入）', () => {
  let db: Database.Database;
  let assembler: PromptAssembler;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at)
      VALUES (1, '昔涟', '{}', '{}', '{}', '[]', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)`).run(now);
    assembler = new PromptAssembler(
      new ProfileStore(db), new PersonaStore(db), new ConversationStore(db),
      new KnowledgeStore(db), new WorldbookStore(db), new CodeContextStore(db),
    );
  });
  afterEach(() => db.close());

  it('★ blocks=chat 但不给 scope ⇒ 世界书不注入（与 2026-10-24 之前逐字相同）', async () => {
    const entry = {
      id: 'x', content: '不该出现的情境提示', content_type: 'text', scope: 'both',
      priority: 5, trigger_words: '', cooldown_sec: 0, created_at: new Date().toISOString(),
    } as any;
    const report = await assembler.assembleWithReport('chat', [entry], [], '', undefined, { blocks: 'chat' });
    expect(report.worldbookInjected).toBe(0);
    expect(report.text).not.toContain('情境提示');
  });
});
