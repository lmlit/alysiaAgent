# Tasks: build-alysia-console-plugin

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
>
> ★ **2026-10-16 更新**：入口注入从 `tapIndex` 改为 `webserver/index-inject` 行。
> 原记录说"踩在**已废弃的** `.agent-presets` / `tapIndex` 上"——**理由不准**，见「R1 更正」。

## R1 更正记录（比改动本身更重要）

**原表述**（`CLAUDE.md` Next 第 7 条 + `dsh-adapter` §5 的表行）：

> 原方案踩在已废弃的 `.agent-presets` / `tapIndex` 上（dsh 桌面端换代了插件机制）

**2026-10-16 在 dsh 产物（`app.asar`）里逐条核实后更正**：

| 说法 | 核实结果 |
|---|---|
| `.agent-presets` 已废弃 | ✅ **对**（§5 早有查证）。且本包**早已不用它** —— 走的是 `dsh.bundle.patch` → `cordis.patch.yml`，也就是新机制 `install_bundle` |
| `tapIndex` 已废弃 | ❌ **不对**。`tapIndex` 仍在（8 处命中），dsh 自己的文档称它是「**任何行都无法表达的标记的逃生口**」 |

**真问题**：dsh 的 index 输入分**两层** ——
① `collectIndexInjections()` 收集 `webserver/index-inject` 的**行** → `renderIndex()` 渲染进正文；
② 再按注册顺序应用原始 `tapIndex` 转换。
而 **桌面端 UI 不走 `renderIndex()`** ⇒ **`tapIndex` 在桌面端根本不执行**
⇒ 插件装得上、路由注册得上，但**入口脚本永远不会进页面**（悬浮球不出现）。

**为什么这个更正重要**：错理由（"已废弃"）会让人以为**整个方案要重写**；
实际只需**换注入方式**——路由、反代、面板全都能留。

## 实现任务

- [x] 建包 `packages/dsh-console`（package.json + cordis.patch.yml + src/）
- [x] host 侧：`inject: ['webServer']`；静态托管 `/alysia-console/widget.js`
- [x] **host 侧入口注入：改用 `ctx.on('webserver/index-inject', table => table.push(...))`** ★ 2026-10-16
      - 两条行分工（照 dsh 自己注入前端资源的方式）：
        `{kind:'script-preload', src}`（head 的 preload **提示**，**不执行**）
        + `{kind:'script-src', placement:'body', src}`（真正执行；渲染器**不加 defer**，位置即时序保证）
      - 顺带确认：**不再依赖"已注入则跳过"那种去重** —— 注入表每次渲染都是全新的，
        而 widget 自身幂等（`window.__alysiaConsole` 守卫 + 复用旧 root），注两次也不会出两个悬浮球
      - 类型侧补了 `IndexInjection` / `IndexInjectionTable` / `Events` 声明
        （不声明 `Events` 的话 tsc 报 `not assignable to 'keyof Events'`）
- [x] host 侧 API 反代：`/alysia-api/*` → `http://127.0.0.1:6185/api/*`
- [x] client 侧入口：悬浮按钮 → 面板抽屉
- [x] 面板页 1：画像 · 面板页 2：会话管理
- [ ] 面板页 3：世界书 + 生活模板（list/add/delete）
- [ ] 面板页 4：记忆旋钮（adjustMemoryConfig 表单）
- [ ] 面板页 5：审计/状态
- [ ] 皮肤联动：**部分已做** —— `console-ui.ts` 已用 `--dsw-alias-*` token（带默认值回退）；
      未做的是**逐项核一遍**是否有漏网的硬编码色值
- [x] 单元测试（反代转发 / **index-inject 行** / 静态托管 / **不再用 tapIndex 的回归守卫**）
- [ ] **手动验收：`install_bundle` 装进 web profile 后，在真实 dsh web 里看到悬浮球**
      ⚠️ 这一步必须能跑 GUI 的环境（本机跑不了 GUI）

## ⚠️ 装 bundle 的前置（本轮发现）

`main` 指向 `dist/index.js`，而 **`dist/` 是 gitignored** ⇒
**装 bundle 前必须先 `npm run build`**，否则 dsh 加载的是旧产物（甚至没有产物）。

## Apply 任务

- [x] A.1 spec 侧：`dsh-adapter` §5 的表行更正（理由改成"桌面端不执行"，并记已修/未做）
- [x] A.2 更正 `CLAUDE.md` Next 第 7 条的同一处误述
- [ ] A.3 合并 §6 到 `openspec/specs/dsh-adapter/spec.md`（**待本 change 全部做完**）
- [ ] A.4 更新 `openspec/specs/index.md`（dsh-adapter 行最后变更）
- [ ] A.5 归档

## 验证记录（2026-10-16）

| 项 | 命令（workdir `packages/dsh-console`） | 结果 |
|---|---|---|
| 类型 | `npx tsc --noEmit` | exit 0 |
| 单元 | `npx vitest run` | **1 file / 8 passed**（原 6 例 → 8 例：新增 index-inject 行断言、tapIndex 回归守卫、mountPath 贯穿） |
| 构建 | `npm run build` | exit 0（`dist/` 已更新为新逻辑，但 gitignored 不入库） |

⚠️ **我此前统计漏了这个包**：一直报"四包 1229 全绿"，而 `packages/dsh-console` 的 6 例从未跑过。
⇒ 真值应为 **1235**（core 767 + server 254 + dsh-adapter 108 + console 100 + dsh-console 6… 现为 8 ⇒ **1237**）。
