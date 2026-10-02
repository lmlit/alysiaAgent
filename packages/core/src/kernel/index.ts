/**
 * module-kernel — alysia 的模块装载内核。
 *
 * 详见 `openspec/specs/module-kernel/spec.md`；设计背景见 `docs/dsh-plugin-architecture.md` §4。
 *
 * ★ 本模块**零侵入**：不修改任何现有文件，也不被现有代码 import。
 *   接入发生在 P1（change: modularize-core-assembly）。
 */

export { ModuleHost } from './host.js';
export type { ModuleHostOptions } from './host.js';
export { createModuleContext } from './context.js';
export type { ModuleContextDeps } from './context.js';
export type { EffectDisposer, Module, ModuleContext, ModuleLogger } from './types.js';
