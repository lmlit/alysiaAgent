# Change Proposal: drop-electron-desktop

## 元信息

- **日期**: 2026-09-25
- **类型**: MODIFY（砍形态 + 附带清理）
- **状态**: in_progress
- **影响 spec**: `webui-system`（§8 Electron 整节）、`alysia-architecture`（端形态表述）、
  `alysia-console`（§5 移除 `/desktop` 预览页）

## 动机（为什么做）

用户决定：**Electron 桌面端不要了**。

背景事实（本次核查）：
- `build-alysia-console-plugin`（8-26）已写过"窗口端已砍，dsh 是唯一前端载体"
- 实现上 `packages/desktop` 是 fork `packages/server` + 固定 6185 + 共用 `packages/server/data`，
  **不是** spec §8 描述的"AlysiaCore + userData db + 随机端口"（§8 早已过时）
- 它 load `/#/chat`（hash 路由）与 `/pet.html` —— **都是 webui 独有的**，
  与 `packages/console` 不兼容
- 它与本地 server 同端口同库：两个一起开时子进程绑不上端口（静默失败）

**级联影响**：Electron 是"废掉 webui"三个约束之一（另两个是 Live2D 资产、pet.html）。
本 change 拆掉这一个；Live2D 用户已决定迁往 console（另开 change），pet.html 随 Electron 一起走。

## 需求（做什么）

- [ ] 删 `packages/desktop/`（4 个文件：main.ts / preload.cjs / package.json / tsconfig.json）
- [ ] 删 console 的 `/desktop` 预览页（`app/desktop/page.tsx` + `components/desktop/desktop-client.tsx`）
      —— 它演示的是"Windows/macOS 常驻窗口"这个**已不存在的产品形态**
- [ ] 删 `app-shell.tsx` 的「桌面端」导航项
- [ ] **删 `packages/console/lib/mock-data.ts`** —— 删掉 desktop 页后无任何代码引用；
      它是 mock 臆造字段（「口语化/稳定性/情绪记忆/主动唤起」）的源头，一并终结
- [ ] 清 stale 注释：`server/src/bootstrap.ts` 里"桌面模式（Electron 壳）保持 webui"等
- [ ] 更新 spec：`webui-system` §8、`alysia-architecture`（3 处）
- [ ] 保留 `ALYSIA_DESKTOP` / `IS_DESKTOP` —— 它仍是有效模式（跳过 IM 适配器与主动推送的
      UI-only 本地模式），只是不再有 Electron 壳去设置它

## 设计决策（怎么做，含备选与取舍）

**决策 1：物理删除，不做"标记废弃"**

`packages/desktop` **未在任何工作区改动中**，删掉可随时 `git checkout -- packages/desktop` 恢复。
留一个死包会让"桌面端到底还要不要"反复成为噪音。

**决策 2：连 console 的 `/desktop` 预览页一起删**

它是"产品形态预览"，而那个形态（常驻桌面窗口）不再存在。留着它等于对外承诺一个没有的东西，
且它顶着"数据为样例"的横幅 —— 删掉比改文案干净。

**决策 3：保留 `IS_DESKTOP` 开关本身**

它的语义（跳过 IM 适配器 + 主动推送，绑回环）仍有用（纯 UI 本地调试），
删掉是另一件事。本 change 只清理"Electron 壳"相关的注释与文档。

**决策 4：`webui-system` 不整体删除**

Live2D 实现（`webui/src/live2d/` + 9.1MB 模型）还要迁往 console，迁完再开 change 删 webui。
本 change 只标记 webui 的 Electron/桌宠部分失效。

## 对账方向确认

- [x] `webui-system` §8 与实现**早已不符**（写 userData db + 随机端口，实现是 fork server + 6185 +
      共用 data）。方向：**改 doc**（记载已删除，不迁就旧描述）
- [x] `alysia-architecture` §"多个端（服务端、桌面端）"、目录树 `desktop/`、平台表 `Desktop` 三处
      需改为"仅服务端"
- [x] 涉及 Web API？**不涉及**

## 测试计划

- `pnpm -r build` 通过（desktop 消失后 workspace 仍完整）
- console 构建产物不含 `/desktop` 路由（原 6 路由 → 5）
- core / server / console 测试全绿
- 无头 Edge：`/desktop` 返回 404 页；导航栏无「桌面端」；其余页面正常
