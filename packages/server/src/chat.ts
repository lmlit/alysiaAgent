/**
 * 昔涟 · ALYSIA — 完整 CLI 聊天客户端
 * 使用完整 Pipeline: Persona + Memory(6 Store) + Agent + Tools
 *
 * Usage:
 *   cd packages/server
 *   source ../../.env
 *   npx tsx src/chat.ts
 *
 * Commands:
 *   /exit   — 退出
 *   /clear  — 清空记忆
 *   /stats  — Token 统计
 *   /new    — 新建对话
 */
// Load .env from project root before anything else
import { readFileSync } from 'fs';
import { resolve } from 'path';
const envPath = resolve(process.cwd(), '..', '..', '.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
  console.log(`  [.env loaded from ${envPath}]`);
} catch { /* .env not found, use existing env */ }

import { AlysiaCore } from '@alysia/core';
import { MessageEvent, MessageType, MessageChain } from '@alysia/core/platform';
import type { Message, MessageSender } from '@alysia/core/platform';
import * as readline from 'readline';

const OWNER_ID = process.env.ALYSIA_OWNER_ID || 'local-user';
const DATA_DIR = process.env.ALYSIA_DATA_DIR || './data';

async function main() {
  console.log('╔══════════════════════════════╗');
  console.log('║      昔涟 · ALYSIA           ║');
  console.log('║   完整 Pipeline 已苏醒         ║');
  console.log('╚══════════════════════════════╝');
  console.log('  初始化记忆系统 + 人设 + Agent...\n');

  const core = new AlysiaCore({
    dbPath: `${DATA_DIR}/alysia-chat.db`,
    ownerId: OWNER_ID,
    workspaceDir: `${DATA_DIR}/workspace`,
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

  console.log(`  人设: soul + identity + system + style 已加载`);
  console.log(`  记忆: EventLog + Profile + Persona + Worldbook + Conversation + Knowledge`);
  console.log(`  工具: shell_exec + write_file + read_file + list_files + web_search + reminder`);
  console.log(`  命令: /new /reset /stats /exit /clear\n`);
  console.log('  输入 /exit 退出  /clear 清空上下文  /wipe 清除全部记忆  /stats 用量\n');

  let sessionId = 'local-chat';
  // 对话历史 — 跨轮次保持
  const history: Array<{ role: string; content: string }> = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n> ',
  });

  // Register platform for this session
  core.registerPlatform(`cli::private:${sessionId}`, core.scheduler);

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }
    if (input === '/exit') {
      console.log('\n  昔涟轻轻点了点头，消失在记忆的涟漪中...\n');
      break;
    }
    if (input === '/clear') {
      history.length = 0;
      await core.memoryManager.onSessionEnd(sessionId);
      sessionId = `local-chat-${Date.now()}`;
      core.registerPlatform(`cli::private:${sessionId}`, core.scheduler);
      console.log('  [记忆已归档，开始新对话]');
      rl.prompt();
      continue;
    }
    if (input === '/new') {
      sessionId = `local-chat-${Date.now()}`;
      core.registerPlatform(`cli::private:${sessionId}`, core.scheduler);
      console.log('  [新对话已创建]');
      rl.prompt();
      continue;
    }
    if (input === '/stats') {
      const stats = (core as any).getSessionStats?.(`cli::private:${sessionId}`) || { recordCount: 0, totalTokens: 0 };
      console.log(`  📊 请求: ${stats.recordCount}  |  总 Token: ${stats.totalTokens.toLocaleString()}`);
      rl.prompt();
      continue;
    }

    const sender: MessageSender = { userId: OWNER_ID, nickname: '伙伴' };
    const message: Message = {
      sessionId,
      groupId: '',
      sender,
      messageId: `msg-${Date.now()}`,
      type: MessageType.PRIVATE,
      content: [{ type: 'plain', text: input }],
      raw: null,
    };

    const event = new MessageEvent({
      messageStr: input,
      messageObj: message,
      platformMeta: { name: 'cli', description: 'Local CLI', id: 'cli-1' },
      sessionId,
    });

    // Inject conversation history so the Agent remembers previous turns
    event.setExtra('conversation_history', [...history]);
    history.push({ role: 'user', content: input });

    // Print 昔涟's response
    let replyText = '';
    event.send = async (chain: MessageChain) => {
      for (const comp of chain) {
        if (comp.type === 'plain') {
          replyText += (comp as any).text;
          process.stdout.write('  ' + (comp as any).text.replace(/\n/g, '\n  ') + '\n');
        }
      }
    };

    try {
      await core.scheduler.execute(event);
    } catch (err: any) {
      console.log(`  ❌ 出错了: ${err.message}`);
    }

    if (replyText) {
      history.push({ role: 'assistant', content: replyText });
    }
    // Keep last 30 turns
    if (history.length > 60) history.splice(0, history.length - 60);

    rl.prompt();
  }

  rl.close();
  await core.stop();
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
