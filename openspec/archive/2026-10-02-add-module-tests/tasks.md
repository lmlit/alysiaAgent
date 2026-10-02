# Tasks: add-module-tests

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 脚手架

- [x] `tests/modules/helpers.ts`：`runModule(module, config, deps, seed)`
      —— 隔离宿主 + `stub()` 喂依赖 + `makeTestLogger()` 捕获日志
- [x] seed 支持 `Module | [Module, config]`（补全依赖链时要带配置）

## 各模块单测

- [x] `resources.test.ts`（8）
      - `al:db`：建库 + schema + 提供句柄；缺配置抛错
      - `al:vector`：正常提供 store；★ **失败降级为 null + warn 级日志，不中止整树**
      - `al:embed`：端点 / Bearer / 请求体 / 维度；响应体异常抛错带原文
      - `al:memory-llm`：★ **第三参 sampling 进请求体**；不传时字段不出现
- [x] `capabilities.test.ts`（7）
      - `al:provider`：首个注册者成为默认
      - `al:tools`：聊天 + 自进化工具常在；★ **codeMode 门控（含子开关）**
      - `al:commands`：提供 CommandRegistry
      - ★ 缺配置 → **装配期响亮失败**（不注册半成品服务）
- [x] `loop.test.ts`（7）
      - ★ **Coalescer 是同一实例**（既进 PipelineContext 又作 stage）
      - 7 段管线顺序固定
      - `al:boot`：initialize → dispatch 顺序；★ **`eventBus.stop` 是 effect，卸载时必须跑到**
      - dispatch reject 不炸宿主，进 error 日志
- [x] `memory.test.ts`（6）
      - 4 资源 → MemoryManager；★ **vector=null 仍可构造**（降级路径）
      - `al:persona-seed`：seed 生效 + `provides:false` 不占服务名 + roles 目录缺失静默跳过

## 实现改动（日志走注入）

- [x] `loop.ts`：`bootModule` 的 dispatch 错误日志改 `ctx.logger`
- [x] `resources.ts`：`vectorModule` 的两处日志改 `ctx.logger`
- [x] `capabilities.ts`：`commandsModule` 改 `ctx.logger`；`registerChatTools` 加 `log` 形参
- [x] `memory.ts`：`loadRolePackages` 加 `log` 形参
- [x] 清理 `loop.ts` 不再使用的全局 logger import

## 不做（有意偏离计划，理由见 proposal）

- [x] ~~拆到 `modules/<name>/` 独立目录~~ → 当前规模下是纯搬运；
      **并入 P3**（届时模块到 ~20 个 + 有 prompts 资源目录，目录结构才有意义）

## Apply 任务

- [x] `openspec/specs/module-kernel/spec.md` §3 补「模块级单测」的落实情况
- [x] `openspec/specs/index.md` 更新
- [x] `docs/HANDOFF.md`：P2 完成 → 下一步 P3

## 验收结果（2026-10-01）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 模块级单测 | **0** | ✅ **28 passed**（4 文件） |
| 常规全仓 | 820 | ✅ **848 passed**（74 files） |
| E2E（真 API） | 5/5 | ✅ **5 passed / 4 files**（未回归） |
| core / server tsc | — | ✅ 均退出码 0 |

## 中途发现

1. **测试自己的装配错被内核抓住**：`al:persona-seed` 注入 `al:memory` 但我没装它 →
   内核在 `validate()` 阶段直接报「没有任何模块声明 provides 它」。
   **这反而验证了内核的依赖校验是真的在工作**（不是摆设）。
2. **模块用全局 logger 会绕过宿主** → 隔离测试注入的日志器收不到模块日志。
   已统一切到 `ctx.logger`。
