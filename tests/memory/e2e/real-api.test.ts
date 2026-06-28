// E2E test with real DeepSeek API (LLM only; embeddings not supported by DeepSeek)
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../../src/memory/MemoryManager';
import { initializeDatabase } from '../../../src/memory/database';
import { OpenAILLMService } from '../../../src/memory/services/OpenAILLMService';
import { loadConfig } from '../../../src/memory/services/config';
import type { MemoryEvent } from '../../../src/memory/types';
import type { IEmbedService } from '../../../src/memory/interfaces/IEmbedService';

const config = loadConfig();

// Stub embed service — DeepSeek doesn't support /v1/embeddings
const stubEmbed: IEmbedService = {
  embed: async () => {
    throw new Error('Embedding not available');
  },
  dimension: () => 0,
};

describe('Real API — DeepSeek LLM', () => {
  let db: Database.Database;
  let manager: MemoryManager;
  let llmService: OpenAILLMService;

  beforeEach(() => {
    if (!config.apiKey) {
      throw new Error('OPENAI_API_KEY not set');
    }

    db = new Database(':memory:');
    initializeDatabase(db);

    llmService = new OpenAILLMService(config);
    manager = new MemoryManager(db, null, stubEmbed, llmService);
  });

  afterEach(() => db.close());

  it('should use real LLM for session summary and profile extraction', async () => {
    console.log(`\n🔑 API:  ${config.baseUrl}`);
    console.log(`💬 Model: ${config.chatModel}\n`);

    const sessionId = 'sess-real-1';
    const events: MemoryEvent[] = [
      { id: 'r1', session_id: sessionId, source: 'chat', type: 'message',
        payload: { role: 'user', content: '你好，我是后端工程师，主要用 TypeScript 和 Rust' },
        importance: 0.6, created_at: '2026-06-28T10:00:00Z', processed: 0 },
      { id: 'r2', session_id: sessionId, source: 'chat', type: 'message',
        payload: { role: 'assistant', content: '你好！TypeScript 和 Rust 是很强的组合' },
        importance: 0.3, created_at: '2026-06-28T10:00:02Z', processed: 0 },
      { id: 'r3', session_id: sessionId, source: 'chat', type: 'message',
        payload: { role: 'user', content: '我比较喜欢直接的沟通方式，代码风格偏好显式命名' },
        importance: 0.7, created_at: '2026-06-28T10:00:05Z', processed: 0 },
      { id: 'r4', session_id: sessionId, source: 'chat', type: 'message',
        payload: { role: 'assistant', content: '了解，直接沟通 + 显式命名，我会记住' },
        importance: 0.3, created_at: '2026-06-28T10:00:07Z', processed: 0 },
    ];

    // Phase 1: Ingest events (realtime processing fires LLM for persona signals)
    console.log('📥 Ingesting 4 events...');
    for (const event of events) {
      await manager.ingest(event);
    }
    // Wait a moment for realtime processing to complete
    await new Promise(r => setTimeout(r, 1000));
    console.log('✅ Events stored\n');

    // Phase 2: Session end — LLM summary generation + profile extraction
    console.log('📝 Session end (LLM summary + profile extraction)...');
    await manager.onSessionEnd(sessionId);
    console.log('✅ Session complete\n');

    // Phase 3: Check generated summary
    const conversations = db.prepare('SELECT * FROM conversations WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;
    for (const c of conversations) {
      console.log('📋 Summary:');
      console.log(`   ${c.summary}`);
      console.log(`   Topics: ${c.topics}`);
      console.log(`   Messages: ${c.message_count}`);
    }

    // Phase 4: Check extracted profile facts
    const profile = db.prepare('SELECT * FROM user_profile WHERE id = 1').get() as Record<string, unknown>;
    const facts = JSON.parse(profile.facts as string);
    console.log(`\n📊 Profile facts (${facts.length}):`);
    for (const f of facts) {
      console.log(`   - ${f.fact} (confidence: ${f.confidence}, source: ${f.source_event})`);
    }

    // Phase 5: Assemble prompts using real persona and profile data
    console.log('\n─── Chat Prompt ───');
    const chatPrompt = await manager.assemble('chat');
    console.log(chatPrompt);
    console.log(`\n   Tokens: ~${chatPrompt.length} chars`);

    console.log('\n─── Code Prompt ───');
    const codePrompt = await manager.assemble('code');
    console.log(codePrompt);
    console.log(`\n   Tokens: ~${codePrompt.length} chars`);

    // Verify
    expect(conversations.length).toBeGreaterThan(0);
    expect(facts.length).toBeGreaterThan(0);
    expect(chatPrompt).toContain('昔涟');
    expect(chatPrompt.length).toBeGreaterThan(100);
    // Code prompt is minimal until CronProcessor rewrites facts→preferences
    // That's expected — facts are extracted, deep profile happens later
    expect(codePrompt.length).toBeGreaterThan(20);

    console.log('\n💡 Code prompt is short because technical profile (preferences)');
    console.log('   comes from CronProcessor deep rewrite, not session-end extract.');
    console.log('   Facts exist (see above) — they just haven\'t been summarized yet.');
    console.log('\n✅ Full pipeline verified with real DeepSeek API');
  }, 120000);
});
