# Spec 变更: modularize-core-assembly

> 本 change **不新增 spec**，只兑现 `module-kernel` §5 已声明的验收基线，
> 并在 `alysia-architecture` 里补上装配方式。
> 两处已 apply 合并，此处留变更记录。

## 1. 变更内容

### `module-kernel` §5（对现有代码的约束）

`+` 标记 P1 已兑现（13 个模块 + ModuleHost，行为逐位保留，冒烟测试锁定）。

### `alysia-architecture` §2.1 / §2.2

```diff
 - Stage 接口设计时预留细粒度拆分扩展点
+  - ★ 2026-10-01：「细粒度拆分扩展点」落在 module-kernel。
+    内核只做拓扑排序/安装/逆序卸载。
+  - ✅ 2026-10-01：AlysiaCore.start() 已改成「注册 13 个模块 + 跑 ModuleHost」，
+    公开面逐字不变。模块定义在 packages/core/src/modules/。
+    新增两个入口文件：src/kernel/（装载内核）、src/options.ts（构造选项，
+    从 index.ts 抽出以解 modules/ 的循环依赖）。
+  - server 侧的 bootstrap.ts 仍是总装脚本 → P3 范围。
```

## 2. 装配契约（新增事实，供后续查阅）

### 2.1 模块清单与依赖图

```
层级0  al:db  al:vector  al:embed  al:memory-llm  al:provider  al:eventbus
层级1  al:memory ←(db,vector,embed,memory-llm)   al:coalescer ←(eventbus)
层级2  al:persona-seed / al:tools / al:commands ←(memory)
层级3  al:pipeline ←(memory,provider,tools,commands,coalescer)
层级4  al:boot ←(pipeline,eventbus)
```

对应关系（旧 `AlysiaCore.start()` 的行号 → 模块）：

| 旧行号 | 模块 |
|---|---|
| `index.ts:103-106` | `al:db` |
| `index.ts:110-124` | `al:vector`（critical:false + **显式 provide(null)** 保留原降级） |
| `index.ts:127-152` | `al:embed` |
| `index.ts:157-177` | `al:memory-llm` |
| `index.ts:179` | `al:memory` |
| `index.ts:182-187` | `al:persona-seed`（provides:false） |
| `index.ts:190-197` | `al:provider` |
| `index.ts:200-204` | `al:tools` |
| `index.ts:207-227` | `al:commands` |
| `index.ts:232-233` | `al:coalescer` |
| `index.ts:236-253` | `al:pipeline` |
| `index.ts:256-257` | `al:eventbus` |
| `index.ts:260-261` | `al:boot`（provides:false） |

### 2.2 ★ 三条必须靠断言守住的装配性质

这三条**破坏了不会报错**，只能靠测试守：

1. **Coalescer 是同一个实例** —— 既在 `PipelineContext.coalescer`（`llm-agent.ts:159/254`
   取打断 signal），又作管线第 3 个 stage（`coalescer.ts:65`）。
   拆成两个实例 → 管线照跑、打断永久失效、`isGenerating` 永远 false。
2. **reminder 工具先 core 版后 server 版** —— `ToolRegistry` 是 Map 同名覆盖，
   `al:tools` 注册 no-op persist 版本，`bootstrap.ts:246` 在 `start()` **之后**覆盖成
   真实持久化版本。顺序反了会静默用错版本。
3. **`loadRolePackages` 的静默跳过** —— 目录不存在直接 return，单包解析失败记 error 继续。
   这是原语义，不是遗漏。

### 2.3 公开面（逐字不变）

`memoryManager` / `providerManager` / `toolRegistry` / `commandRegistry` / `eventBus` /
`scheduler` / `coalescer` / `sampling` / `start()` / `stop()` / `registerPlatform()` /
`isGenerating()` / `registerChatTools()` / `registerCodeTools()`

实现方式：`start()` 跑完 `ModuleHost` 后从 `host.get(服务名)` 回填这些字段。

## 3. 本 change 明确没做的事（留独立 change）

| 事项 | 为什么不做 | 归属 |
|---|---|---|
| `db.close()` / LanceDB 释放 | 是**行为变更**，本 change 自我约束是「行为不变」 | `unify-core-shutdown` |
| `al:memory-llm` 收编进 ProviderManager | 同上（会引入超时/fallback，行为变了） | 独立 change |
| `bootstrap.ts` 模块化 | P3 范围 | `modularize-server-assembly` |
| 6 段巨型 systemPrompt 外置 | P4 范围 | 同上 |
