import type { EffectDisposer, ModuleContext, ModuleLogger } from './types.js';

/** 事件 handler */
type Handler = (...args: unknown[]) => void;

export interface ModuleContextDeps {
  /** 模块名 */
  name: string;
  /** 模块配置 */
  config: unknown;
  /** 宿主级服务表（跨模块共享） */
  services: Map<string, unknown>;
  /** 服务名 → 提供者模块名（仅用于错误信息） */
  serviceOwners: Map<string, string>;
  logger: ModuleLogger;
  /** 本模块声明的服务名；`false` = 不提供任何服务 */
  declared: readonly string[] | false;
  /** 本模块的清理器栈（宿主 stop 时逆序执行） */
  effects: EffectDisposer[];
  /** 宿主级事件表 */
  events: Map<string, Set<Handler>>;
  /** 宿主是否已 stop（stop 后一切注册都该被拒绝） */
  isStopped: () => boolean;
}

/**
 * 建一个模块上下文。
 *
 * ★ 所有校验都**立刻抛错**而不是静默降级——静默失败是这个项目反复踩过的坑
 *   （见 `docs/HANDOFF.md`：「成功日志掩盖了没做的事」）。
 */
export function createModuleContext<S>(deps: ModuleContextDeps): ModuleContext<S> {
  const { name, config, services, serviceOwners, logger, declared, effects, events, isStopped } = deps;

  const allowed = declared === false ? new Set<string>() : new Set(declared);

  /** stop 之后拒绝一切注册——对应 cordis 的 INACTIVE_EFFECT */
  function assertActive(what: string): void {
    if (isStopped()) {
      throw new Error(
        `[kernel] 模块 "${name}" 在宿主 stop() 之后调用 ${what} —— 宿主已卸载，注册不会被回收`,
      );
    }
  }

  return {
    name,
    config: config as S,
    logger,

    get<T = unknown>(n: string): T | undefined {
      return services.get(n) as T | undefined;
    },

    provide<T>(n: string, value: T): void {
      assertActive('ctx.provide()');
      if (!allowed.has(n)) {
        const hint = declared === false
          ? '本模块声明了 provides: false（不提供任何服务）'
          : `本模块声明的服务：${[...allowed].join(', ') || '(无)'}`;
        throw new Error(
          `[kernel] 模块 "${name}" 试图 provide 未声明的服务 "${n}"：${hint}。`
          + ` —— 请把它补进 Module.provides，否则依赖方永远解析不到。`,
        );
      }
      if (services.has(n)) {
        const owner = serviceOwners.get(n) ?? '(未知)';
        throw new Error(
          `[kernel] 服务名冲突："${n}" 已被模块 "${owner}" 提供，模块 "${name}" 又想提供它。`
          + ` —— 服务是依赖不是工具，同名冲突意味着两处对它有不同实现意图（不做静默覆盖）。`,
        );
      }
      services.set(n, value);
      serviceOwners.set(n, name);
    },

    effect(setup: () => EffectDisposer | void, label?: string): void {
      assertActive(`ctx.effect()${label ? `（${label}）` : ''}`);
      const disposer = setup();
      if (typeof disposer === 'function') {
        effects.push(disposer);
      }
    },

    on(event: string, handler: Handler): () => void {
      assertActive(`ctx.on("${event}")`);
      let set = events.get(event);
      if (!set) {
        set = new Set();
        events.set(event, set);
      }
      set.add(handler);
      const off = (): void => {
        set.delete(handler);
      };
      effects.push(off);
      return off;
    },

    emit(event: string, ...args: unknown[]): void {
      const set = events.get(event);
      if (!set || set.size === 0) return;
      // 快照遍历：handler 内 off() 自己不会打乱本次派发
      for (const handler of [...set]) {
        try {
          handler(...args);
        } catch (err) {
          logger.error(`[kernel] 模块 "${name}" emit "${event}" 时 handler 抛错：`, err);
        }
      }
    },
  };
}
