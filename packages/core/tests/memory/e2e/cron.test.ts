// Test CronProcessor deep profile rewrite with real APIs
import { describe, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../../src/memory/MemoryManager';
import { initializeDatabase } from '../../../src/memory/database';
import { OpenAILLMService } from '../../../src/memory/services/OpenAILLMService';
import { OpenAIEmbedService } from '../../../src/memory/services/OpenAIEmbedService';
import { loadConfig } from '../../../src/memory/services/config';
import type { MemoryEvent } from '../../../src/memory/types';

const config = loadConfig();

describe('Cron — Deep Profile Rewrite', () => {
  let db: Database.Database;
  let manager: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    const llmService = new OpenAILLMService(config);
    const embedService = new OpenAIEmbedService(config);
    manager = new MemoryManager(db, null, embedService, llmService);
  });

  afterEach(() => db.close());

  it('should run cron() and produce structured profile', async () => {
    // Populate some facts first (simulate accumulated session data)
    const sessionId = 'sess-cron-1';
    const events: MemoryEvent[] = [
      { id: 'c1', session_id: sessionId, source: 'chat', type: 'message',
        payload: { role: 'user', content: '我是后端工程师，做了5年，主要用TypeScript和Rust' },
        importance: 0.7, created_at: '2026-06-28T10:00:00Z', processed: 0 },
      { id: 'c2', session_id: sessionId, source: 'chat', type: 'message',
        payload: { role: 'user', content: '代码风格我喜欢显式命名，注释用中文' },
        importance: 0.6, created_at: '2026-06-28T10:00:10Z', processed: 0 },
      { id: 'c3', session_id: sessionId, source: 'chat', type: 'message',
        payload: { role: 'user', content: '在学Rust生命周期和所有权，最近卡在智能指针这块' },
        importance: 0.5, created_at: '2026-06-28T10:00:20Z', processed: 0 },
    ];

    console.log('📥 Populating 3 events...');
    for (const e of events) {
      await manager.ingest(e);
    }
    await new Promise(r => setTimeout(r, 500));

    // End session to extract facts
    console.log('📝 Session end...');
    await manager.onSessionEnd(sessionId);

    // Show facts before cron
    const before = db.prepare('SELECT * FROM user_profile WHERE id = 1').get() as Record<string, unknown>;
    console.log(`\n📊 Before cron:`);
    console.log(`   basics:      ${before.basics}`);
    console.log(`   preferences: ${before.preferences}`);
    console.log(`   facts:       ${JSON.parse(before.facts as string).length} items`);

    // Run cron — deep profile rewrite
    console.log('\n⏰ Running cron() — deep profile rewrite...');
    await manager.cron();

    // Show profile after cron
    const after = db.prepare('SELECT * FROM user_profile WHERE id = 1').get() as Record<string, unknown>;
    console.log(`\n📊 After cron:`);
    console.log(`   basics:      ${after.basics}`);
    console.log(`   preferences: ${after.preferences}`);
    console.log(`   facts:       ${JSON.parse(after.facts as string).length} items`);

    // Assemble both prompts
    console.log('\n─── Chat Prompt ───');
    const chatPrompt = await manager.assemble('chat');
    console.log(chatPrompt);

    console.log('\n─── Code Prompt ───');
    const codePrompt = await manager.assemble('code');
    console.log(codePrompt);

    // Verify basics is populated (natural language from LLM deep rewrite)
    expect(after.basics).not.toBe('{}');
    expect((after.basics as string).length).toBeGreaterThan(20);
    expect(chatPrompt.length).toBeGreaterThan(200);
    expect(codePrompt.length).toBeGreaterThan(100);

    console.log('\n✅ Cron deep rewrite successful — structured profile ready');
  }, 120000);
});
