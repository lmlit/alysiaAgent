/**
 * server 侧内置模块（change: modularize-server-assembly，P3）。
 *
 * 依赖图（DAG，由 `ModuleHost` 拓扑排序保证顺序）：
 *
 * ```
 * 层级0  al:config
 * 层级1  al:logging ←(config)          al:vision ←(config)
 * 层级2  al:core ←(config, logging)
 * 层级3  al:adapters ←(core, config, vision)
 * 层级4  al:proactive / al:reminder ←(core, config, push)
 * 层级5  al:life ←(core, config, push, proactive)
 *        al:cron ←(core)
 *        al:webui ←(core, config)
 * ```
 *
 * 与 core 侧 13 个模块的分工：
 *   - core 模块（`packages/core/src/modules/`）构造 agent 本体；
 *   - server 模块（本目录）接平台、跑定时、托管管理面板。
 */

export { configModule } from './config.js';
export type { RuntimeConfig, ConfigModuleOptions } from './config.js';

export { loggingModule } from './logging.js';
export { coreModule } from './core.js';
export { visionModule } from './vision.js';
export { adaptersModule } from './adapters.js';
export { proactiveModule } from './proactive.js';
export { lifeModule } from './life.js';
export { reminderModule } from './reminder.js';
export { cronModule } from './cron.js';
export { webuiModule } from './webui.js';
export type { WebuiModuleOptions } from './webui.js';
