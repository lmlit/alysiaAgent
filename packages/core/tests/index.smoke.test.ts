/**
 * `AlysiaCore` 冒烟测试 —— 锁住 `start()` 的**公开面契约**。
 *
 * ★ 2026-10-01 新增。此前 **没有任何测试覆盖 AlysiaCore**（`start()` 是测试盲区），
 *   而 P1（change: modularize-core-assembly）要把 `start()` 从 13 步硬编码总装
 *   改成「注册模块 + 跑 ModuleHost」。没有这个测试，"747 全绿"对 P1 毫无保护作用。
 *
 * 只断言**通过公开 API 可观察的行为**，不碰内部结构——这样重构实现不误报，
 * 真改坏了才报。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AlysiaCore } from '../src/index.js';
import type { AlysiaCoreOptions } from '../src/index.js';
import { MessageEvent } from '../src/platform/event.js';
import { MessageType } from '../src/platform/types.js';
import type { Message, MessageSender, PlainComponent } from '../src/platform/message.js';
import type { PlatformMetadata } from '../src/platform/types.js';

const platformMeta: PlatformMetadata = { name: 'smoke', description: '冒烟', id: 'smoke-1' };

/** 起一个隔离的 core（临时目录 + 不可达的 LLM 地址——start() 不该调 LLM） */
function makeCore(dir: string, over: Partial<AlysiaCoreOptions> = {}): AlysiaCore {
  return new AlysiaCore({
    dbPath: join(dir, 'alysia.db'),
    ownerId: 'owner-smoke',
    workspaceDir: dir,
    // 不可达地址：若 start() 意外发起 LLM/embedding 请求，会立刻失败而不是静默挂起
    llmConfig: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'test' },
    embedConfig: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', model: 'test' },
    features: { codeMode: false },
    ...over,
  });
}

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'alysia-smoke-'));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch { /* 临时目录清理失败不影响结论 */ }
  }
});

describe('AlysiaCore 冒烟 / 聊天模式（codeMode=false）', () => {
  let core: AlysiaCore;

  // ★ 用 beforeAll 而不是「第一个 it 里 start()」：后者一旦 start 失败，
  //   后续 5 个用例会各自以 TypeError 级联失败，把真正的错因淹掉。
  //   ★ 超时必须放宽：全量并行跑时 CPU 争抢会让 start() 从 ~0.7s 涨到 5s+。
  beforeAll(async () => {
    core = makeCore(tmp());
    await core.start();
  }, 60_000);

  it('start() 后公开面全部就绪', () => {
    expect(core.memoryManager).toBeDefined();
    expect(core.providerManager).toBeDefined();
    expect(core.toolRegistry).toBeDefined();
    expect(core.commandRegistry).toBeDefined();
    expect(core.eventBus).toBeDefined();
    expect(core.scheduler).toBeDefined();
    expect(core.coalescer).toBeDefined();
    expect(core.sampling).toBeDefined();
    expect(typeof core.isGenerating).toBe('function');
  });

  it('聊天工具全部注册', () => {
    const names = core.toolRegistry.toToolSet().names();
    for (const n of ['web_search', 'get_weather', 'lookup_worldbook', 'set_reminder',
      'list_reminders', 'cancel_reminder', 'write_worldbook', 'add_life_template',
      'delete_worldbook_entry', 'confirm_profile_fact', 'delete_life_template']) {
      expect(names, `缺少工具 ${n}`).toContain(n);
    }
  });

  it('codeMode=false 时不注册 shell / 文件系统工具', () => {
    const names = core.toolRegistry.toToolSet().names();
    for (const n of ['shell_exec', 'write_file', 'read_file', 'list_files']) {
      expect(names, `不该有 ${n}`).not.toContain(n);
    }
  });

  it('persona 与 worldbook 已 seed 进库', () => {
    expect(core.memoryManager.getActiveSystemPrompt().length).toBeGreaterThan(0);
    expect(core.memoryManager.listWorldbookEntries().length).toBeGreaterThan(0);
  });

  it('isGenerating 对陌生会话返回 false', () => {
    expect(core.isGenerating('nobody')).toBe(false);
  });

  it('registerPlatform 不抛错且可重复调用', () => {
    expect(() => {
      core.registerPlatform('smoke::private');
      core.registerPlatform('smoke::group');
      core.registerPlatform('smoke2::private', core.scheduler);
    }).not.toThrow();
  });

  it('★ Coalescer 是同一个实例（守住打断链路）', () => {
    // 它既要在 PipelineContext 里（LLMAgentStage 经 ctx.coalescer 取打断 signal，
    // llm-agent.ts:159/254），又要作为管线第 3 个 stage（coalescer.ts:65）。
    //
    // ★ 这个性质极易被重构破坏，而且**破坏了不会报错**——拆成两个实例后
    //   管线照跑，只是打断永远不生效、isGenerating 永远 false。
    //   PipelineScheduler.ctx/.stages 是 TS private（运行时仍可访问），
    //   这里刻意破封装去断言，因为它是 start() 装配正确性的唯一可观察出口。
    const scheduler = core.scheduler as unknown as {
      ctx: { coalescer?: unknown };
      stages: unknown[];
    };
    expect(scheduler.ctx.coalescer).toBe(core.coalescer);
    expect(scheduler.stages).toContain(core.coalescer);
  });

  it('★ 消息真的流过了管线（EventBus → scheduler → PII → memory ingest 落库）', async () => {
    // 前面几个用例只证明「字段非空」。这个证明**它真的能跑**——
    // 一条消息从 EventBus 进、经 scheduler 路由、跑完 PII + MemoryIngest 两段、
    // 最终落进事件库。任何一环装配错了这条断言就会挂。
    core.eventBus.setDefaultScheduler(core.scheduler);

    const sessionId = `smoke-e2e-${Date.now()}`;
    const sender: MessageSender = { userId: 'u-e2e', nickname: 'E2E' };
    const messageObj: Message = {
      sessionId,
      groupId: '',
      sender,
      messageId: `m-${Date.now()}`,
      type: MessageType.PRIVATE,
      content: [{ type: 'plain', text: '管线冒烟消息' }],
      raw: null,
    };
    const event = new MessageEvent({
      messageStr: '管线冒烟消息',
      messageObj,
      platformMeta,
      sessionId,
    });

    core.eventBus.put(event);

    // ingest 是异步落库的（RealtimeProcessor fire-and-forget）——轮询等它出现
    const deadline = Date.now() + 10_000;
    let found: unknown[] = [];
    while (Date.now() < deadline) {
      found = core.memoryManager.getRecentMessages(event.unifiedMsgOrigin, 10);
      if (found.length > 0) break;
      await new Promise(r => setTimeout(r, 50));
    }

    expect(
      found.length,
      '消息没流过管线——EventBus 派发 / scheduler 路由 / memory-ingest 至少一处装错了',
    ).toBeGreaterThan(0);
  }, 30_000);

  it('stop() 后 eventBus 停止派发', async () => {
    await core.stop();
    // 幂等：再停一次不抛
    await expect(core.stop()).resolves.toBeUndefined();
  });
});

describe('AlysiaCore 冒烟 / 编程模式（codeMode=true）', () => {
  it('注册 shell + 文件系统工具', async () => {
    const core = makeCore(tmp(), { features: { codeMode: true } });
    await core.start();

    const names = core.toolRegistry.toToolSet().names();
    for (const n of ['shell_exec', 'write_file', 'read_file', 'list_files']) {
      expect(names, `缺少工具 ${n}`).toContain(n);
    }
    // 聊天工具照常在
    expect(names).toContain('web_search');

    await core.stop();
  }, 60_000);
});

describe('AlysiaCore 冒烟 / 采样配置', () => {
  it('sampling 默认值与传入值深合并', async () => {
    const core = makeCore(tmp(), { sampling: { chat: { temperature: 0.42 } } });
    await core.start();

    expect(core.sampling.chat.temperature).toBe(0.42);

    await core.stop();
  }, 60_000);
});
