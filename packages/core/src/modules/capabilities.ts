/**
 * 能力模块 —— `AlysiaCore.start()` 的第 9-11 步（change: modularize-core-assembly）。
 *
 * provider（LLM 客户端池）/ tools（工具注册表）/ commands（会话命令）。
 */

import { ProviderManager } from '../provider/manager.js';
import { ToolRegistry } from '../tools/registry.js';
import { CommandRegistry } from '../commands/registry.js';
import { createWebSearchTool, createWeatherTool } from '../tools/web-search.js';
import { createWorldbookTool } from '../tools/worldbook.js';
import {
  createReminderTool,
  createListRemindersTool,
  createCancelReminderTool,
} from '../tools/reminder.js';
import { createSelfEvolveTools } from '../tools/self-evolve.js';
import { createShellExecTool } from '../tools/shell.js';
import {
  createWriteFileTool,
  createReadFileTool,
  createListFilesTool,
} from '../tools/filesystem.js';
import { createSessionCommands } from '../commands/session.js';
import { createStatsCommand } from '../commands/stats.js';
import { logger } from '../utils/logger.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { AlysiaFeatures } from '../options.js';
import type { Module, ModuleLogger } from '../kernel/index.js';

// ── 工具注册（抽成独立函数：模块与 AlysiaCore 的公开方法复用同一份实现）──

/**
 * 注册聊天工具：服务端 + 桌面端都启用。
 *
 * ★ 这里用的是 **no-op persist**（内存调度不变）——真实持久化由 server 的
 *   `bootstrap.ts:246` 在 `start()` 之后**同名覆盖**这三个 reminder 工具。
 *   `ToolRegistry` 是 Map 同名覆盖，所以顺序不能变：先 core 版，后 server 版。
 *   （见 `openspec/specs/module-kernel/spec.md` §5 的验收基线）
 */
export function registerChatTools(
  registry: ToolRegistry,
  memoryManager: MemoryManager,
  db: unknown,
  /** 由调用方注入（模块传 `ctx.logger`；`AlysiaCore` 公开方法走默认） */
  log: ModuleLogger = logger,
): void {
  registry.register(createWebSearchTool());
  registry.register(createWeatherTool());
  registry.register(createWorldbookTool(db as any));
  // ★ 8-12 桌面端/CLI 路径无 SQLite 持久化：no-op persist（内存调度不变）
  const noopPersist = { save: () => {}, remove: () => {} };
  registry.register(createReminderTool(async (text: string): Promise<boolean> => {
    log.info(`Reminder triggered: ${text}`);
    return true; // 仅日志路径视为已处理（无推送通道）
  }, noopPersist));
  registry.register(createListRemindersTool());
  registry.register(createCancelReminderTool(noopPersist));
  // ★ 8-14 内容自进化（content-self-evolution）：自写 worldbook/life 模板 + 用户指令删除
  for (const tool of createSelfEvolveTools(memoryManager)) {
    registry.register(tool);
  }
  // 表情包不再注册为工具 — 改用文案内标记 [表情包:名字]，发送时解析（LLMAgentStage + adapter）
}

/** 注册编程工具（shell / filesystem）。仅 codeMode 开启时调用 */
export function registerCodeTools(
  registry: ToolRegistry,
  workspaceDir: string,
  features: AlysiaFeatures,
): void {
  if (features.shell !== false) {
    registry.register(createShellExecTool(workspaceDir));
  }
  if (features.filesystem !== false) {
    registry.register(createWriteFileTool(workspaceDir));
    registry.register(createReadFileTool(workspaceDir));
    registry.register(createListFilesTool(workspaceDir));
  }
}

// ── al:provider ───────────────────────────────────────────────

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** LLM Provider 池。对应 `index.ts:190-197` */
export const providerModule: Module<ProviderConfig> = {
  name: 'al:provider',
  apply(ctx, config) {
    const cfg = config!;
    const providerManager = new ProviderManager();
    providerManager.registerProvider({
      id: cfg.id,
      type: 'openai',
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
    });
    ctx.provide('al:provider', providerManager);
  },
};

// ── al:tools ──────────────────────────────────────────────────

export interface ToolsConfig {
  features: AlysiaFeatures;
  workspaceDir: string;
}

/** 工具注册表。对应 `index.ts:200-204` */
export const toolsModule: Module<ToolsConfig> = {
  name: 'al:tools',
  inject: ['al:memory', 'al:db'],
  apply(ctx, config) {
    const cfg = config!;
    const registry = new ToolRegistry();
    registerChatTools(registry, ctx.get<MemoryManager>('al:memory')!, ctx.get('al:db'), ctx.logger);
    if (cfg.features.codeMode) {
      registerCodeTools(registry, cfg.workspaceDir, cfg.features);
    }
    ctx.provide('al:tools', registry);
  },
};

// ── al:commands ───────────────────────────────────────────────

export interface CommandsConfig {
  ownerId: string;
}

/**
 * 会话命令。对应 `index.ts:207-227`。
 *
 * ⚠️ `/stop` 目前只打日志——源码注释自陈「实际中断机制待 AgentRunner 支持 AbortController」。
 *   原样保留（修它是另一个 change）。
 */
export const commandsModule: Module<CommandsConfig> = {
  name: 'al:commands',
  inject: ['al:memory'],
  apply(ctx) {
    const memoryManager = ctx.get<MemoryManager>('al:memory')!;
    const registry = new CommandRegistry();

    const sessionCmds = createSessionCommands(
      // /new: 保存当前会话记忆后重置上下文
      async (sessionId) => {
        await memoryManager.onSessionEnd(sessionId);
        ctx.logger.info(`[cmd] /new — session saved: ${sessionId.slice(-20)}`);
      },
      // /reset: 清空上下文，不保存记忆
      async (sessionId) => {
        // 标记会话事件为已处理（跳过记忆提取）
        ctx.logger.info(`[cmd] /reset — context cleared: ${sessionId.slice(-20)}`);
      },
      // /stop: 中断标记（实际中断机制待 AgentRunner 支持 AbortController）
      async (sessionId) => {
        ctx.logger.info(`[cmd] /stop — requested for: ${sessionId.slice(-20)}`);
      },
    );
    for (const cmd of sessionCmds) {
      registry.register(cmd);
    }
    registry.register(createStatsCommand((sid) => memoryManager.getTokenStats(sid) as any));

    ctx.provide('al:commands', registry);
  },
};
