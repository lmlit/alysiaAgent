import { logger as defaultLogger } from '../utils/logger.js';
import { createModuleContext } from './context.js';
import type { EffectDisposer, Module, ModuleLogger } from './types.js';

type Handler = (...args: unknown[]) => void;

export interface ModuleHostOptions {
  /** 日志器。默认走 `utils/logger`（宿主不静默吞错） */
  logger?: ModuleLogger;
}

/**
 * 模块宿主 —— 只做三件事：**拓扑排序、安装、逆序卸载**。
 *
 * 不做：配置文件解析、自动装配、服务发现、热重载、scope/isolate。
 * 详见 `openspec/specs/module-kernel/spec.md`。
 */
export class ModuleHost {
  private readonly modules: Module[] = [];
  private readonly byName = new Map<string, Module>();
  private readonly configs = new Map<string, unknown>();
  /** 静态声明：服务名 → 提供者模块名。`use()` 时构建，用于提前校验与重复检测 */
  private readonly declaredProviders = new Map<string, string>();

  private readonly services = new Map<string, unknown>();
  private readonly serviceOwners = new Map<string, string>();
  private readonly events = new Map<string, Set<Handler>>();
  /** 已装模块，按 install 顺序；stop 时逆序 */
  private readonly installed: Array<{ name: string; effects: EffectDisposer[] }> = [];

  private started = false;
  private stopped = false;

  private readonly logger: ModuleLogger;

  constructor(opts: ModuleHostOptions = {}) {
    this.logger = opts.logger ?? defaultLogger;
  }

  /** 登记一个模块。同名模块、重复声明的服务名都在这里立刻抛错 */
  use(module: Module, config?: unknown): this {
    if (this.started) throw new Error(`[kernel] 不能在 start() 之后 use("${module.name}")`);
    if (this.stopped) throw new Error(`[kernel] 不能在 stop() 之后 use("${module.name}")`);

    if (this.byName.has(module.name)) {
      throw new Error(`[kernel] 模块名重复："${module.name}" 已登记过`);
    }

    for (const n of serviceNamesOf(module)) {
      const existing = this.declaredProviders.get(n);
      if (existing !== undefined) {
        throw new Error(
          `[kernel] 服务名重复声明："${n}" 已被模块 "${existing}" 声明，模块 "${module.name}" 又声明了它。`
          + ` —— 服务不做静默覆盖，请改名或合并。`,
        );
      }
      this.declaredProviders.set(n, module.name);
    }

    this.modules.push(module);
    this.byName.set(module.name, module);
    this.configs.set(module.name, config);
    return this;
  }

  /** 取服务（宿主视角；模块内部用 `ctx.get`） */
  get<T = unknown>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  /** 服务是否已就绪 */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /** 按 `inject` 拓扑排序后逐个安装。关键模块失败 → 回滚已装的并抛出 */
  async start(): Promise<void> {
    if (this.started) throw new Error('[kernel] ModuleHost 不支持重启，请新建实例');
    if (this.stopped) throw new Error('[kernel] ModuleHost 已 stop，不能重新 start');

    this.validate();

    const order = this.topoSort();

    try {
      for (const module of order) {
        await this.installOne(module);
      }
    } catch (err) {
      // 关键失败 → 回滚已装的（逆序），清干净服务表，再抛。
      // ★ 只回滚不清理会让宿主报告已被卸载的服务——依赖方拿到幽灵服务。
      await this.rollback();
      this.clearRegistries();
      this.stopped = true;
      throw err;
    }

    this.started = true;
    this.logger.info(`[kernel] 已装载 ${this.installed.length}/${this.modules.length} 个模块`);
  }

  /** 逆序卸载全部模块。幂等 */
  async stop(): Promise<void> {
    if (this.stopped) return;
    // ★ 先置位：卸载过程中任何 ctx.effect()/on()/provide() 都该被拒绝
    this.stopped = true;
    await this.rollback();
    this.clearRegistries();
    this.started = false;
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 静态校验：每个 inject 名都必须有模块声明过 provides */
  private validate(): void {
    for (const m of this.modules) {
      for (const dep of m.inject ?? []) {
        if (!this.declaredProviders.has(dep)) {
          throw new Error(
            `[kernel] 模块 "${m.name}" 声明了 inject: "${dep}"，`
            + `但没有任何模块声明 provides 它。可用的服务：${[...this.declaredProviders.keys()].join(', ') || '(无)'}`,
          );
        }
      }
    }
  }

  /** 模块级拓扑排序：依赖先入结果。有环则抛错并报出环路径 */
  private topoSort(): Module[] {
    const result: Module[] = [];
    /** 0=未访问 1=在栈上 2=已完成 */
    const state = new Map<string, 0 | 1 | 2>();
    const stack: string[] = [];

    /** 本模块依赖的模块 */
    const depsOf = (m: Module): string[] =>
      (m.inject ?? []).map(dep => this.declaredProviders.get(dep)!);

    const visit = (name: string): void => {
      const st = state.get(name) ?? 0;
      if (st === 2) return;
      if (st === 1) {
        const at = stack.indexOf(name);
        throw new Error(`[kernel] 循环依赖：${[...stack.slice(at), name].join(' → ')}`);
      }
      state.set(name, 1);
      stack.push(name);
      for (const dep of depsOf(this.byName.get(name)!)) visit(dep);
      stack.pop();
      state.set(name, 2);
      result.push(this.byName.get(name)!);
    };

    for (const m of this.modules) visit(m.name);
    return result;
  }

  /** 装一个模块：先校验 inject（不进入模块代码），再 apply */
  private async installOne(module: Module): Promise<void> {
    const label = `[kernel] 模块 "${module.name}"`;
    const effects: EffectDisposer[] = [];

    // 1. inject 校验 —— 必须在 apply **之前**，不进入模块代码
    for (const dep of module.inject ?? []) {
      if (!this.services.has(dep)) {
        const provider = this.declaredProviders.get(dep)!;
        throw new Error(
          `${label} 声明了 inject: "${dep}"，但该服务在它安装时尚未就绪`
          + `（声明由模块 "${provider}" 提供——它可能装得更晚，或因 critical:false 失败而被跳过）。`,
        );
      }
    }

    // 2. apply
    const ctx = createModuleContext({
      name: module.name,
      config: this.configs.get(module.name),
      services: this.services,
      serviceOwners: this.serviceOwners,
      logger: this.logger,
      declared: serviceNamesOf(module),
      effects,
      events: this.events,
      isStopped: () => this.stopped,
    });

    try {
      await module.apply(ctx, this.configs.get(module.name));
    } catch (err) {
      if (module.critical === false) {
        this.logger.error(`${label} apply 失败（critical:false，跳过，不中止整树）：`, err);
        // ★ 仍然登记它声明的服务（值为 undefined），让依赖方拿到"降级值"而不是整体中止。
        //   这正是 alysia 现有语义：LanceDB 失败 → vectorStore = null → 文本检索兜底。
        this.registerDegraded(module);
        this.installed.push({ name: module.name, effects });
        return;
      }
      throw new Error(`${label} apply 失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }

    this.installed.push({ name: module.name, effects });
  }

  /** 可选模块失败后，把它声明的服务登记为 undefined */
  private registerDegraded(module: Module): void {
    for (const n of serviceNamesOf(module)) {
      if (!this.services.has(n)) {
        this.services.set(n, undefined);
        this.serviceOwners.set(n, module.name);
      }
    }
  }

  /** 清空运行时登记表（stop 与启动失败回滚共用） */
  private clearRegistries(): void {
    this.events.clear();
    this.services.clear();
    this.serviceOwners.clear();
  }

  private async rollback(): Promise<void> {
    while (this.installed.length > 0) {
      const entry = this.installed.pop()!;
      await this.disposeEntry(entry);
    }
  }

  /** 逆序跑清理器。单个抛错被吞进日志，不中断其他 */
  private async disposeEntry(entry: { name: string; effects: EffectDisposer[] }): Promise<void> {
    for (let i = entry.effects.length - 1; i >= 0; i--) {
      try {
        await entry.effects[i]();
      } catch (err) {
        this.logger.error(
          `[kernel] 模块 "${entry.name}" 的清理器抛错（已忽略，继续清理其余）：`,
          err,
        );
      }
    }
  }
}

/** 模块声明的服务名（`provides: false` → 空） */
function serviceNamesOf(module: Module): readonly string[] {
  if (module.provides === false) return [];
  return module.provides ?? [module.name];
}
