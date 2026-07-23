/**
 * CLI test runner — exercises the full Alysia pipeline locally.
 * Usage: cd packages/server && npx tsx src/cli-runner.ts
 *
 * Reads from stdin, prints 昔涟's response, exits.
 */
import { AlysiaCore } from '@alysia/core';
import { MessageEvent, MessageType, MessageChain } from '@alysia/core/platform';
import type { Message, MessageSender } from '@alysia/core/platform';

const OWNER_ID = process.env.ALYSIA_OWNER_ID || 'local-user';

async function main() {
  // Read the prompt from command line args or stdin
  const prompt = process.argv.slice(2).join(' ') || '昔涟，你好呀！';
  console.log(`>>> 伙伴: ${prompt}\n`);

  // Load .env if present (dotenv is pre-installed via tsx)
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
  console.log('[Alysia] Core ready. 昔涟已苏醒。\n');

  const sender: MessageSender = { userId: OWNER_ID, nickname: '伙伴' };
  const message: Message = {
    sessionId: 'cli-session',
    groupId: '',
    sender,
    messageId: `msg-${Date.now()}`,
    type: MessageType.PRIVATE,
    content: [{ type: 'plain', text: prompt }],
    raw: null,
  };

  const event = new MessageEvent({
    messageStr: prompt,
    messageObj: message,
    platformMeta: { name: 'cli', description: 'CLI test', id: 'cli-1' },
    sessionId: 'cli-session',
  });

  // Override send → print to stdout
  event.send = async (chain: MessageChain) => {
    for (const comp of chain) {
      if (comp.type === 'plain') {
        process.stdout.write((comp as any).text);
      }
    }
    process.stdout.write('\n');
  };

  core.registerPlatform('cli::private:cli-session', core.scheduler);
  await core.scheduler.execute(event);
  await core.stop();
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
