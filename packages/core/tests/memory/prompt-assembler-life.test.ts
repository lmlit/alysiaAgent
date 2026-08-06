import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/memory/database.js';
import { MemoryManager } from '../../src/memory/MemoryManager.js';

function makeManager(db: Database.Database): MemoryManager {
  const embedService = { embed: async () => [0], dimension: () => 1024 };
  const llmService = { complete: async () => '{}' };
  return new MemoryManager(db as any, null, embedService as any, llmService as any);
}

describe('PromptAssembler life injection', () => {
  let db: Database.Database;
  let mm: MemoryManager;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    mm = makeManager(db);
  });

  it('assemble chat includes life block when events exist', async () => {
    mm.recordLifeEvent({ type: 'chat', content: '在阳台看书，看到一朵像兔子的云' });
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).toContain('[我的近期日常]');
    expect(prompt).toContain('兔子');
  });

  it('assemble chat omits life block when no events', async () => {
    const prompt = await mm.assembleWithWorldbook('chat', [], []);
    expect(prompt).not.toContain('[我的近期日常]');
  });

  it('code mode also gets life block (AI carries its life into code mode)', async () => {
    mm.recordLifeEvent({ type: 'internal', content: '给自己倒了杯水' });
    const prompt = await mm.assembleWithWorldbook('code', [], []);
    expect(prompt).toContain('[我的近期日常]');
  });
});
