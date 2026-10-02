# module-kernel — 模块装载内核

> canonical spec: `openspec/specs/module-kernel/spec.md`
> 设计背景: `docs/dsh-plugin-architecture.md` §4

把「能力」从总装脚本里解放出来，变成可声明、可组合、可逆序卸载的 `Module`。
**只做三件事：拓扑排序、安装、逆序卸载。**

```ts
import { ModuleHost } from './kernel/index.js'

const host = new ModuleHost()
  .use(dbModule, { path: './data/alysia.db' })
  .use(vectorModule)                       // critical: false → 失败降级
  .use(memoryModule)                       // inject: ['al:db', 'al:vector']

await host.start()
// ...
await host.stop()                          // 逆序卸载
```

## 契约速查

| 概念 | 说明 |
|---|---|
| `Module.name` | 模块名，**同时是它的服务名**。建议 `al:` 前缀 |
| `Module.inject` | 依赖的服务名。宿主保证 install 时就绪（**peer 单元内的除外**，见下） |
| `Module.provides` | 将提供的服务名。默认 `[name]`；`false` = 纯副作用模块 |
| `Module.critical` | `false` = apply 失败不中止整树（默认 `true`） |
| `ctx.effect()` | **一切注册必须走它**，否则卸载不回收 |
| `ctx.provide()` | 同名冲突 → throw（**不静默覆盖**） |

## 与 cordis 的对应（二期 dsh 迁移的依据）

| 本项目 | cordis |
|---|---|
| `Module.apply(ctx, config)` | `export function apply(ctx, config)` |
| `Module.name` / `inject` | `export const name` / `inject` |
| `Module.Config` | `export const Config` |
| `ctx.provide` / `ctx.get` | `ctx.set` / `ctx.foo` |
| `ctx.effect` | `ctx.effect`（语义相同） |

**不要为了「更 TS」偏离这张表**——偏离多少，二期翻译层就多厚多少。

## 依赖必须是 DAG

宿主**不做**双向依赖的特殊处理。alysia 的消息处理链是严格单向的：

```
al:eventbus   →   无依赖
al:coalescer  →   al:eventbus    (eventBus.put(merged, {priority:true}) 重入管线)
al:pipeline   →   al:coalescer   (ctx.coalescer 取打断 signal)
```

> `peer` 机制曾在 `add-module-kernel` 里实现过，依据是「Coalescer ↔ EventBus 双向依赖」。
> **那个依据是错的**（`EventBus.ts` 全文不引用 Coalescer）——已于 `drop-kernel-peer` 删除。
> 真出现环时再加，或把环上模块合并成一个。

## 不做

配置 schema 校验 / HMR / 服务发现 / `ctx.override` / scope-isolate-realm / 双向依赖。
理由见 spec §4（scope 那套是 dsh 的概念，alysia 单进程单实例不需要）。
