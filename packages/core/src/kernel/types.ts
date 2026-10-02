/**
 * module-kernel — 模块契约
 *
 * 详见 `openspec/specs/module-kernel/spec.md`（change: add-module-kernel）。
 *
 * ★ 契约刻意做成 cordis 形状：二期包装成 dsh 插件时只写一层薄适配。
 *   对照表见 `docs/dsh-plugin-architecture.md` §4.1——**不要为了"更 TS"偏离它**，
 *   偏离多少，二期翻译层就多厚多少。
 */

/** 结构化日志接口。结构上兼容 `utils/logger.ts` 的 logger 对象。 */
export interface ModuleLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** 清理器：`effect` 的返回值，宿主 stop 时调用。可 async。 */
export type EffectDisposer = () => void | Promise<void>;

/**
 * 模块上下文 —— 模块与宿主之间的唯一接口。
 *
 * ★ `effect` 是硬要求：一切注册（定时器、监听、句柄、子进程）必须走它。
 *   不走 → 模块卸载时不回收 → 泄漏 + 重复注册。
 *   这与 cordis 的 `ctx.effect()` 语义**逐字相同**。
 */
export interface ModuleContext<S = unknown> {
  /** 当前模块名 */
  readonly name: string;

  /** 取服务。未注册返回 undefined（允许可选依赖探测） */
  get<T = unknown>(name: string): T | undefined;

  /**
   * 注册服务。同名冲突 → throw（**不静默覆盖**）。
   *
   * ★ 与 `ToolRegistry` 的 Map 同名覆盖不同：服务是依赖，同名冲突意味着两个模块
   *   对同一个名字有不同的实现意图，静默覆盖会让依赖方拿到意料外的实例。
   *   只能 provide 本模块 `provides` 声明过的名字（防拼写错误）。
   */
  provide<T>(name: string, value: T): void;

  /**
   * 注册清理器。`setup` 立即执行，其返回值在宿主 dispose 时调用。
   * 同一模块内多个清理器**逆序**执行。宿主已 stop 时调用 → throw。
   */
  effect(setup: () => EffectDisposer | void, label?: string): void;

  /** 订阅模块间事件。返回取消订阅函数（同时自动登记为 effect） */
  on(event: string, handler: (...args: unknown[]) => void): () => void;

  /** 发布模块间事件。单个 handler 抛错不中断其他（错误进日志） */
  emit(event: string, ...args: unknown[]): void;

  readonly logger: ModuleLogger;

  /** 模块自身配置（由 `use(module, config)` 传入） */
  readonly config: S;
}

/**
 * 模块定义。
 *
 * 命名约定：模块名用 `al:` 前缀（`al:db` / `al:memory`）。
 * 理由同 dsh——patch 的 id 索引是全树扁平的，通用名（`memory` / `schedule`）
 * 会和出厂行撞名。
 */
export interface Module<S = unknown> {
  /** 模块名。**同时是它的服务名**（除非显式声明 `provides`）。全局唯一。 */
  readonly name: string;

  /** 依赖的服务名。宿主保证 install 时已就绪 */
  readonly inject?: readonly string[];

  /**
   * 本模块将提供的服务名。
   * - `undefined`（默认）→ `[name]`
   * - `false` → 不提供任何服务（纯副作用模块，如 seed / cron）
   * - 数组 → 显式声明（一个模块提供多个服务时用）
   *
   * ★ 静态声明是 `inject` 提前校验和重复检测的依据——运行时不加声明就 provide 会 throw。
   */
  readonly provides?: readonly string[] | false;

  /** `false` = apply 失败不中止整树（默认 `true`）。降级逻辑写在 apply 内部 */
  readonly critical?: boolean;

  /** 配置（本 change 不做 schema 校验；二期映射到 cordis Standard Schema） */
  readonly Config?: unknown;

  apply(ctx: ModuleContext<S>, config?: S): void | Promise<void>;
}
