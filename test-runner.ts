/**
 * Local test runner — exercises the full Alysia pipeline without needing Telegram.
 * Usage: npx tsx test-runner.ts
 */
import { AlysiaCore } from '@alysia/core';
import { MessageEvent } from '@alysia/core/platform';
import { MessageType } from '@alysia/core/platform';
import type { Message, MessageSender } from '@alysia/core/platform';

const OWNER_ID = process.env.ALYSIA_OWNER_ID || 'test-user';

async function main() {
  console.log('[Alysia] Starting local test...\n');

  const core = new AlysiaCore({
    dbPath: './data/alysia-test.db',
    ownerId: OWNER_ID,
    workspaceDir: './data/workspace',
    llmConfig: {
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1',
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.CHAT_MODEL || 'deepseek-v4-flash',
    },
    embedConfig: {
      baseUrl: process.env.EMBED_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: process.env.EMBED_API_KEY || '',
      model: process.env.EMBED_MODEL || 'embedding-2',
    },
  });

  await core.start();
  console.log('[Alysia] Core initialized. Persona loaded.\n');

  // Create a test message event
  const sender: MessageSender = { userId: OWNER_ID, nickname: '伙伴' };
  const message: Message = {
    sessionId: 'local-test',
    groupId: '',
    sender,
    messageId: 'test-1',
    type: MessageType.PRIVATE,
    content: [{ type: 'plain', text: '你好呀，昔涟' }],
    raw: null,
  };

  // Create a real MessageEvent with proper send
  const event = new MessageEvent({
    messageStr: '昔涟，你好呀！',
    messageObj: message,
    platformMeta: { name: 'cli', description: 'CLI test', id: 'cli-test' },
    sessionId: 'local-test',
  });

  // Override send to print to console
  event.send = async (chain) => {
    console.log('\n┌──── 昔涟 ────');
    for (const comp of chain) {
      if (comp.type === 'plain') {
        console.log('│ ' + (comp as any).text);
      } else {
        console.log(`│ [${comp.type}]`);
      }
    }
    console.log('└──────────────\n');
  };

  // Register a separate scheduler for this chat
  core.registerPlatform('cli::private:local-test', core.scheduler);

  // Push event directly to pipeline
  console.log('>>> 伙伴: 昔涟，你好呀！\n');
  await core.scheduler.execute(event);

  await core.stop();
  console.log('[Alysia] Done.');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
