/**
 * `AlysiaCore` 装配 E2E —— 用**真实 API** 跑完整一轮对话。
 *
 * ★ 与 `tests/index.smoke.test.ts` 的分工：
 *   - smoke 用不可达的 LLM 地址，只验证「消息流过 EventBus → ingest 落库」；
 *   - 本测试用真实 DeepSeek + 智谱，验证**完整链路**：
 *     EventBus → scheduler → PII → ingest → Coalescer → 向量检索（真 embedding）
 *     → LLMAgentStage（真 LLM）→ RespondStage → assistant 回复回写 EventLog。
 *
 *   这覆盖了 smoke 碰不到的**检索 + LLM + Respond** 三段——
 *   P1（change: modularize-core-assembly）改的就是这些段的装配。
 *
 * ⚠️ **花真钱、需要 `.env`** → 归属 e2e，正常跑测试用
 *   `--exclude='tests/memory/e2e/*'` 排除。
 *   手动跑：`source .env && npx vitest run tests/memory/e2e/core-turn.test.ts`
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AlysiaCore } from '../../../src/index.js';
import { MessageEvent } from '../../../src/platform/event.js';
import { MessageType } from '../../../src/platform/types.js';
import { loadConfig } from '../../../src/memory/services/config';
import type { Message, MessageSender, PlainComponent } from '../../../src/platform/message.js';
import type { PlatformMetadata } from '../../../src/platform/types.js';
import type { MessageChain } from '../../../src/platform/chain.js';

const config = loadConfig();
const platformMeta: PlatformMetadata = { name: 'turn-e2e', description: '真 API 一轮', id: 'turn-e2e-1' };

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('AlysiaCore E2E — 真实 API 跑完整一轮', () => {
  let dir: string;
  let core: AlysiaCore;

  beforeAll(async () => {
    if (!config.chatApiKey) throw new Error('OPENAI_API_KEY not set');
    if (!config.embedApiKey) throw new Error('EMBED_API_KEY not set');

    dir = mkdtempSync(join(tmpdir(), 'alysia-turn-'));
    core = new AlysiaCore({
      dbPath: join(dir, 'alysia.db'),
      ownerId: 'turn-e2e-owner',
      workspaceDir: dir,
      llmConfig: { baseUrl: config.chatBaseUrl, apiKey: config.chatApiKey, model: config.chatModel },
      embedConfig: { baseUrl: config.embedBaseUrl, apiKey: config.embedApiKey, model: config.embedModel },
      features: { codeMode: false },
    });
    await core.start();
    core.eventBus.setDefaultScheduler(core.scheduler);
  }, 120_000);

  afterAll(async () => {
    await core?.stop();
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ★ Windows 上必然 EPERM：`stop()` 不关 SQLite 句柄（LanceDB 目录同理），
      //   文件被占着删不掉。这是**已知的**生命周期问题，见 change
      //   modularize-core-assembly 的「遗留」节——修复归 unify-core-shutdown。
      //   临时目录留给 OS 清理，不因此判测试失败（它测的是装配不是清理）。
    }
  });

  it('消息走完整管线并拿到 LLM 回复，回复回写进 EventLog', async () => {
    const sessionId = `turn-e2e-${Date.now()}`;
    const sender: MessageSender = { userId: 'turn-e2e-user', nickname: '轻月' };
    const content: PlainComponent[] = [{ type: 'plain', text: '用一句话回答：今天天气适合散步吗？不要调用任何工具。' }];
    const messageObj: Message = {
      sessionId,
      groupId: '',
      sender,
      messageId: `m-${Date.now()}`,
      type: MessageType.PRIVATE,
      content,
      raw: null,
    };

    const event = new MessageEvent({
      messageStr: '用一句话回答：今天天气适合散步吗？不要调用任何工具。',
      messageObj,
      platformMeta,
      sessionId,
    });

    // 捕获平台回复（adapter 就是这么覆写的，见 platform/event.ts:184）
    let reply: string | null = null;
    event.send = async (chain: MessageChain): Promise<void> => {
      reply = chain.getComponents()
        .map(c => (c.type === 'plain' ? ((c as unknown as { text: string }).text ?? '') : `[${c.type}]`))
        .join('');
    };

    core.eventBus.put(event);

    // 真实 LLM 一轮：检索（真 embedding）+ ReAct 循环
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline && !reply) await sleep(200);

    expect(
      reply,
      '没拿到 LLM 回复——检索 / LLMAgentStage / RespondStage 至少一处装错了',
    ).toBeTruthy();
    expect(reply!.length).toBeGreaterThan(0);

    // assistant 回复应当被回写进 EventLog（llm-agent.ts:275-283）
    const rows = core.memoryManager.getRecentMessages(event.unifiedMsgOrigin, 20);
    expect(
      rows.some(r => r.role === 'assistant'),
      'assistant 回复没回写 EventLog',
    ).toBe(true);

    console.log(`\n✅ 完整一轮：\n   用户: ${event.messageStr}\n   昔涟: ${reply}\n`);
  }, 180_000);
});
