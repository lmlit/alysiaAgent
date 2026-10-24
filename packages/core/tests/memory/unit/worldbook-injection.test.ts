// tests/memory/unit/worldbook-injection.test.ts
//
// ★ 2026-10-24（change: `align-dsh-memory-blocks-with-scope`）
//
// 守的是**行为**，不是实现：
//   1. **不给 worldbookScope ⇒ 不注入**（与改动前逐字相同 —— QQ/console 走 lookup_worldbook 工具）
//   2. 给了 scope ⇒ 该 scope（含 both）的条目进 prompt，**image 类型除外**
//   3. 报告里的 `worldbookInjected` = **真正进了 prompt** 的条数（被预算丢掉要如实回 0）
//   4. code 表行为不变（它一直注入 code/both）
//   5. `blocks` 能单独覆盖 `mode` 的块表选择（拆参数的核心诉求）
//
// 为什么值得单独一个文件：这个参数**曾经是死参数** —— 匹配、计数、然后整包扔掉，
// 而日志看起来完全正常（dsh 的世界书就这样静默失效了一个月）。
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import Database from 'better-sqlite3';
import { PromptAssembler } from '../../../src/memory/PromptAssembler';
import { initializeDatabase } from '../../../src/memory/database';
import { ProfileStore } from '../../../src/memory/stores/ProfileStore';
import { PersonaStore } from '../../../src/memory/stores/PersonaStore';
import { ConversationStore } from '../../../src/memory/stores/ConversationStore';
import { KnowledgeStore } from '../../../src/memory/stores/KnowledgeStore';
import { WorldbookStore } from '../../../src/memory/stores/WorldbookStore';
import { CodeContextStore } from '../../../src/memory/stores/CodeContextStore';
import type { WorldbookEntry } from '../../../src/memory/types';

const ISO = '2026-10-24T00:00:00.000Z';
const BOTH_TEXT = '情境条目｜chat 与 code 都该看到';
const CODE_TEXT = '情境条目｜只有 code 该看到';
const CHAT_TEXT = '情境条目｜只有 chat 该看到';
const IMAGE_TEXT = '情境条目｜表情包素材不该进 prompt';

function entry(scope: string, content: string, contentType?: string): WorldbookEntry {
  return {
    id: `wb-${scope}-${content.length}`,
    trigger_keys: JSON.stringify(['x']),
    trigger_mode: 'any',
    content,
    scope,
    priority: 0,
    cooldown_sec: 0,
    last_triggered: null,
    hit_count: 0,
    created_at: ISO,
    updated_at: ISO,
    ...(contentType ? { content_type: contentType } : {}),
  };
}

/** 四个 scope 一次给全，各分支自己挑 */
const ALL: WorldbookEntry[] = [
  entry('both', BOTH_TEXT),
  entry('code', CODE_TEXT),
  entry('chat', CHAT_TEXT),
  entry('code', IMAGE_TEXT, 'image'),
];

describe('世界书注入（worldbookScope opt-in）', () => {
  let db: Database.Database;
  let assembler: PromptAssembler;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    const profileStore = new ProfileStore(db);
    const personaStore = new PersonaStore(db);
    const convStore = new ConversationStore(db, null);
    const knowledgeStore = new KnowledgeStore(db, null);
    const worldbookStore = new WorldbookStore(db);
    const codeContextStore = new CodeContextStore(db);
    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at) VALUES (1, '{}', '{}', '[]', ?)`).run(ISO);
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at) VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}', '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}', '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(ISO);
    assembler = new PromptAssembler(profileStore, personaStore, convStore, knowledgeStore, worldbookStore, codeContextStore);
  });

  afterEach(() => db.close());

  it('★ 不给 worldbookScope ⇒ 一条都不注入（旧行为，逐字不变）', async () => {
    const report = await assembler.assembleWithReport('chat', [], ALL);
    expect(report.text).not.toContain('[情境提示]');
    expect(report.text).not.toContain(BOTH_TEXT);
    expect(report.worldbookInjected, '不注入时报告必须是 0，不能拿匹配数冒充').toBe(0);
  });

  it("scope='code' ⇒ 只注入 code/both，且排除 image", async () => {
    const report = await assembler.assembleWithReport('chat', [], ALL, '', undefined, { worldbookScope: 'code' });
    expect(report.text).toContain('[情境提示]');
    expect(report.text).toContain(BOTH_TEXT);
    expect(report.text).toContain(CODE_TEXT);
    expect(report.text, 'chat scope 的条目不该进 code 情境').not.toContain(CHAT_TEXT);
    expect(report.text, 'image 类型（表情包）不该进 prompt').not.toContain(IMAGE_TEXT);
    expect(report.worldbookInjected, 'code/both 共 2 条（image 那条已滤掉）').toBe(2);
  });

  it("scope='chat' ⇒ 只注入 chat/both（将来给 QQ 开注入时靠这条）", async () => {
    const report = await assembler.assembleWithReport('chat', [], ALL, '', undefined, { worldbookScope: 'chat' });
    expect(report.text).toContain(BOTH_TEXT);
    expect(report.text).toContain(CHAT_TEXT);
    expect(report.text).not.toContain(CODE_TEXT);
    expect(report.worldbookInjected).toBe(2);
  });

  it('预算不足被丢掉时，报告必须回 0（不能拿匹配数冒充注入数）', async () => {
    // 单条就撑爆 3200 预算 —— 走的是 pushChatBlock 的 optional 丢弃分支
    const huge = entry('code', '超'.repeat(20000));
    const report = await assembler.assembleWithReport('chat', [], [huge], '', undefined, { worldbookScope: 'code' });
    expect(report.dropped, '该块应当被记为丢弃').toContain('worldbook');
    expect(report.text).not.toContain('[情境提示]');
    expect(report.worldbookInjected).toBe(0);
  });

  it('★ code 表行为不变：仍然注入 code/both，并如实回填条数', async () => {
    const report = await assembler.assembleWithReport('code', [], ALL);
    expect(report.text).toContain('[情境提示]');
    expect(report.text).toContain(CODE_TEXT);
    expect(report.text).not.toContain(CHAT_TEXT);
    expect(report.worldbookInjected).toBe(2);
  });

  it('★ blocks 能单独覆盖 mode 的块表选择（拆参数的核心诉求）', async () => {
    // mode='code' 但 blocks='chat' ⇒ 走 chat 表：该有人味块（【说话的分寸】），
    // 且世界书只在给了 scope 时注入。
    const report = await assembler.assembleWithReport('code', [], ALL, '', undefined, {
      blocks: 'chat',
      worldbookScope: 'code',
    });
    expect(report.text, 'chat 表才有【说话的分寸】').toContain('【说话的分寸】');
    expect(report.text).toContain(CODE_TEXT);
    expect(report.worldbookInjected).toBe(2);
  });
});
