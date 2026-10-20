/**
 * ★ 2026-10-20（change: `tabular-prompt-blocks`，A 类重构）—— **行为特征快照（characterization test）**
 *
 * ## 这个文件是干什么的
 *
 * 它**不测"应该怎样"**，它测"现在怎样"。目的是给重构上一道保险：
 * 先把装配出来的整段 prompt **拍成底片**，重构后再拍一次 —— 两次必须逐字相同。
 *
 * 这是 A 类重构**唯一可信的保证手段**：如果重构后快照变了，
 * 说明行为变了（哪怕测试全绿），那就**不许** update 快照，必须回头改代码。
 *
 * ⚠️ **纪律：不要 `vitest -u`**。这个快照一旦被更新，它就从"证据"退化成"装饰"。
 *
 * ## 覆盖的分支（对应 PromptAssembler 里每条 `canFit`）
 *
 * | 场景 | 想钉住什么 |
 * |---|---|
 * | `chat/rich` | 正常顺序：角色 → 稳定变化 → 关于你 → 偏好 → 事实 → 日常 |
 * | `chat/empty` | 空库时**哪些块完全不出现**（不留空标题） |
 * | `chat/starved` | **预算不够时丢谁**（这是重构最容易改坏的一支） |
 * | `code/rich` | 编程模式的块顺序与 2450 预算口径 |
 *
 * 时间字段全部写死（`valid_from` / `updated_at` 用常量），否则快照会随运行时间漂移。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PromptAssembler } from '../../../src/memory/PromptAssembler';
import { initializeDatabase } from '../../../src/memory/database';
import { ProfileStore } from '../../../src/memory/stores/ProfileStore';
import { PersonaStore } from '../../../src/memory/stores/PersonaStore';
import { ConversationStore } from '../../../src/memory/stores/ConversationStore';
import { KnowledgeStore } from '../../../src/memory/stores/KnowledgeStore';
import { WorldbookStore } from '../../../src/memory/stores/WorldbookStore';
import { CodeContextStore } from '../../../src/memory/stores/CodeContextStore';

const FIXED_TIME = '2026-10-01T08:00:00.000Z';

/** 固定时间的一条画像事实（形状与 ProfileExtractor 产出的一致） */
function fact(factText: string, over: Record<string, unknown> = {}) {
  return {
    fact: factText,
    confidence: 0.9,
    evidence: `证据：${factText}`,
    source_event: 'evt-1',
    updated_at: FIXED_TIME,
    source: 'user',
    valid_from: FIXED_TIME,
    valid_until: '2027-10-01T08:00:00.000Z',
    status: 'active',
    category: 'general',
    channel: 'qq',
    ...over,
  };
}

describe('PromptAssembler —— 行为特征快照（重构安全网）', () => {
  let db: Database.Database;
  let assembler: PromptAssembler;
  let profileStore: ProfileStore;
  let personaStore: PersonaStore;
  let codeContextStore: CodeContextStore;
  let convStore: ConversationStore;
  let knowledgeStore: KnowledgeStore;
  let worldbookStore: WorldbookStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    profileStore = new ProfileStore(db);
    personaStore = new PersonaStore(db);
    convStore = new ConversationStore(db, null);
    knowledgeStore = new KnowledgeStore(db, null);
    worldbookStore = new WorldbookStore(db);
    codeContextStore = new CodeContextStore(db);

    db.prepare(`INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at) VALUES (1, '{}', '{}', '[]', ?)`).run(FIXED_TIME);
    db.prepare(`INSERT OR IGNORE INTO persona (id, name, tone, speech_style, emotional_range, adaptation_hints, updated_at) VALUES (1, '昔涟', '{"formality":0,"warmth":0.2,"humor":0.1,"directness":0}', '{"sentence_length":0,"emoji_usage":0,"code_heavy":0}', '{"expressiveness":0.1,"empathy":0.3,"playfulness":0.1}', '[]', ?)`).run(FIXED_TIME);

    assembler = new PromptAssembler(profileStore, personaStore, convStore, knowledgeStore, worldbookStore, codeContextStore);
  });

  afterEach(() => db.close());

  it('chat/empty：空库时哪些块完全不出现', async () => {
    const prompt = await assembler.assemble('chat');
    expect(prompt).toMatchSnapshot();
  });

  it('chat/rich：正常块顺序', async () => {
    profileStore.updateBasics('用户是后端工程师，最近在做一个叫 alysiaAgent 的项目。');
    profileStore.updatePreferences('喜欢简洁的回答，不喜欢长篇大论。');
    db.prepare('UPDATE user_profile SET facts = ? WHERE id = 1').run(JSON.stringify([
      fact('用户在长沙', { category: 'identity' }),
      fact('用户喜欢玩《老头环》', { category: 'preference', source: 'inferred' }),
      fact('用户最近在学日语', { category: 'status' }),
    ]));

    const prompt = await assembler.assemble('chat', [], [], '【我的近期日常】\n- 今天 09:12 在阳台晒了太阳');
    expect(prompt).toMatchSnapshot();
  });

  it('chat/starved：预算不够时丢谁（最容易改坏的一支）', async () => {
    // 40 条事实 + 超长 basics：把 3200 token 预算吃满，逼出 canFit=false 的分支
    profileStore.updateBasics('长'.repeat(4000));
    db.prepare('UPDATE user_profile SET facts = ? WHERE id = 1').run(JSON.stringify(
      Array.from({ length: 40 }, (_, i) => fact(`用户的事实编号 ${i}：` + '内容'.repeat(12), { category: 'general' })),
    ));

    const prompt = await assembler.assemble('chat', [], [], '【我的近期日常】\n- 今天 09:12 在阳台晒了太阳');
    expect(prompt).toMatchSnapshot();
  });

  it('code/rich：编程模式的块顺序', async () => {
    profileStore.updateBasics('{"occupation":"后端工程师","experience":"5年"}');
    profileStore.updatePreferences('{"code_languages":["TypeScript","Rust"],"code_style":"explicit"}');
    codeContextStore.upsert({
      id: 'ctx-1', project_name: 'alysiaAgent', project_path: '/work/alysiaAgent',
      tech_stack: '{"lang":"typescript"}', architecture_notes: 'Electron app',
      recent_changes: '[]', decisions: '[]', is_active: 1,
      created_at: FIXED_TIME, updated_at: FIXED_TIME,
    });

    const prompt = await assembler.assemble('code');
    expect(prompt).toMatchSnapshot();
  });
});
