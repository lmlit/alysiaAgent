/**
 * 能力模块（`modules/capabilities.ts`）单测。
 *
 * 重点守 `codeMode` 门控——它是**唯一的 feature flag 行为**，
 * 而 flag 失效的表现是「服务端偷偷多了 shell 工具」，不会有任何报错。
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { CommandRegistry } from '../../src/commands/registry.js';
import { ProviderManager } from '../../src/provider/manager.js';
import { providerModule, toolsModule, commandsModule } from '../../src/modules/capabilities.js';
import { runModule, stub } from './helpers.js';

/** 工具模块只需 memory 有 `createSelfEvolveTools` 用到的形状；构造期不调用其方法 */
const memoryStub: Array<[string, unknown]> = [['al:memory', {}], ['al:db', {}]];
const baseCfg = { features: { codeMode: false }, workspaceDir: 'C:/ws' };

const CHAT_TOOLS = ['web_search', 'get_weather', 'lookup_worldbook',
  'set_reminder', 'list_reminders', 'cancel_reminder'];
const SELF_EVOLVE_TOOLS = ['write_worldbook', 'add_life_template', 'delete_worldbook_entry',
  'confirm_profile_fact', 'delete_life_template'];
const CODE_TOOLS = ['shell_exec', 'write_file', 'read_file', 'list_files'];

describe('al:provider', () => {
  it('注册的 provider 成为默认（首个注册者）且可查', async () => {
    const r = await runModule(providerModule, {
      id: 'default', baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm',
    });
    const pm = r.get<ProviderManager>('al:provider')!;
    expect(pm).toBeInstanceOf(ProviderManager);
    expect(pm.getById('default')).toBeDefined();
    // 首个注册的自动成为默认 —— 原实现依赖这个行为（只注册了一个 provider）
    expect(() => pm.getDefault()).not.toThrow();
    await r.stop();
  });
});

describe('al:tools', () => {
  it('聊天工具 + 内容自进化工具总是注册', async () => {
    const r = await runModule(toolsModule, baseCfg, memoryStub);
    const names = r.get<ToolRegistry>('al:tools')!.toToolSet().names();
    for (const n of [...CHAT_TOOLS, ...SELF_EVOLVE_TOOLS]) {
      expect(names, `缺少 ${n}`).toContain(n);
    }
    await r.stop();
  });

  it('★ codeMode=false → 一个编程工具都不注册', async () => {
    const r = await runModule(toolsModule, baseCfg, memoryStub);
    const names = r.get<ToolRegistry>('al:tools')!.toToolSet().names();
    for (const n of CODE_TOOLS) expect(names, `不该有 ${n}`).not.toContain(n);
    await r.stop();
  });

  it('★ codeMode=true → 注册全部编程工具', async () => {
    const r = await runModule(
      toolsModule,
      { features: { codeMode: true }, workspaceDir: 'C:/ws' },
      memoryStub,
    );
    const names = r.get<ToolRegistry>('al:tools')!.toToolSet().names();
    for (const n of CODE_TOOLS) expect(names, `缺少 ${n}`).toContain(n);
    await r.stop();
  });

  it('codeMode=true 但单个子开关关掉 → 那一类不注册', async () => {
    const r = await runModule(
      toolsModule,
      { features: { codeMode: true, shell: false }, workspaceDir: 'C:/ws' },
      memoryStub,
    );
    const names = r.get<ToolRegistry>('al:tools')!.toToolSet().names();
    expect(names).not.toContain('shell_exec');
    expect(names).toContain('read_file');  // filesystem 仍开
    await r.stop();
  });
});

describe('al:commands', () => {
  it('提供 CommandRegistry（会话命令 + stats）', async () => {
    const r = await runModule(commandsModule, { ownerId: 'o1' }, [['al:memory', { getTokenStats: () => ({}) }]]);
    expect(r.get('al:commands')).toBeInstanceOf(CommandRegistry);
    await r.stop();
  });
});

describe('模块缺配置时响亮失败', () => {
  it('★ al:provider 没拿到 config → 中止整树，不注册半成品 provider', async () => {
    // 静默注册一个 id 为 undefined 的 provider 会让所有 LLM 调用在**运行时**才炸，
    // 且报错位置离根因很远。这里的断言保证它在**装配期**就停。
    await expect(runModule(providerModule, undefined as never)).rejects.toThrow(/al:provider.*apply 失败/);
  });

  it('★ al:tools 没拿到 config → 同样立刻失败', async () => {
    await expect(runModule(toolsModule, undefined as never, memoryStub)).rejects.toThrow(/al:tools.*apply 失败/);
  });
});
