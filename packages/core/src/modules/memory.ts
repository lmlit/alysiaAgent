/**
 * 记忆模块 —— `AlysiaCore.start()` 的第 6-8 步（change: modularize-core-assembly）。
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { MemoryManager } from '../memory/MemoryManager.js';
import { seedPersona, seedWorldbook } from '../persona/loader.js';
import { logger } from '../utils/logger.js';
import type { SamplingConfig } from '../provider/sampling.js';
import type { Module, ModuleLogger } from '../kernel/index.js';

// ── al:memory ─────────────────────────────────────────────────

export interface MemoryConfig {
  /** ★ 8-10 采样参数（DEFAULT + config.yml 深合并后） */
  sampling: SamplingConfig;
}

/**
 * `MemoryManager` —— 记忆系统门面。对应 `index.ts:179`。
 *
 * ★ 它吃 4 个基础资源服务。`al:vector` 可能是 `null`（LanceDB 降级），
 *   MemoryManager 内部据此走文本检索兜底——原实现传的就是 `vectorStore as any`。
 */
export const memoryModule: Module<MemoryConfig> = {
  name: 'al:memory',
  inject: ['al:db', 'al:vector', 'al:embed', 'al:memory-llm'],
  apply(ctx, config) {
    if (!config) throw new Error('[al:memory] 缺少配置 { sampling }');
    const db = ctx.get('al:db');
    const vectorStore = ctx.get('al:vector');
    const embedService = ctx.get('al:embed');
    const llmService = ctx.get('al:memory-llm');

    const memoryManager = new MemoryManager(
      db as any,
      vectorStore as any,
      embedService as any,
      llmService as any,
      config.sampling,
    );
    ctx.provide('al:memory', memoryManager);
  },
};

// ── al:persona-seed ───────────────────────────────────────────

export interface PersonaSeedConfig {
  /** 工作目录（角色包从 `{workspaceDir}/../roles` 或 `{workspaceDir}/roles` 读） */
  workspaceDir: string;
}

/**
 * 人格 / 世界书种子 + 角色包自动加载。对应 `index.ts:182-187`。
 *
 * ★ **失败语义必须逐字保留**：
 *   - `loadRolePackages` 整个包在 try/catch 里，catch 为空（目录不存在就跳过）
 *   - 单个角色包解析失败 → `logger.error` 后继续下一个
 *   不要「顺手」改成记录日志或抛错——那是行为变更。
 */
export const personaSeedModule: Module<PersonaSeedConfig> = {
  name: 'al:persona-seed',
  provides: false,
  inject: ['al:memory'],
  async apply(ctx, config) {
    const memoryManager = ctx.get<MemoryManager>('al:memory')!;
    await seedPersona(memoryManager);
    await seedWorldbook(memoryManager);
    // 传 ctx.logger 而非模块级全局 logger —— 让本模块在隔离测试里可观测
    await loadRolePackages(memoryManager, config?.workspaceDir ?? process.cwd(), ctx.logger);
  },
};

/**
 * 角色包目录自动加载：`{dataDir}/roles/*.json` → `importRole()`
 * 角色包格式见 `docs/superpowers/specs/2026-07-31-role-system.md`
 *
 * @param log 由调用方注入（模块传 `ctx.logger`）
 */
async function loadRolePackages(
  memoryManager: MemoryManager,
  workspaceDir: string,
  log: ModuleLogger = logger,
): Promise<void> {
  try {
    // 兼容两种位置：workspaceDir/../roles 与 workspaceDir/roles
    const candidates = [
      resolve(workspaceDir, '..', 'roles'),
      resolve(workspaceDir, 'roles'),
    ];
    const dir = candidates.find(d => existsSync(d));
    if (!dir) return;

    for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(resolve(dir, file), 'utf-8'));
        const result = memoryManager.importRole(pkg);
        log.info(`Role package loaded: ${file} → ${result.role} (${result.worldbookCount} worldbook)`);
      } catch (err: any) {
        log.error(`Failed to load role package ${file}:`, err.message);
      }
    }
  } catch { /* roles dir not available — skip */ }
}
