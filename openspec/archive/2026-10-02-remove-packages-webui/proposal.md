# Change Proposal: remove-packages-webui

## 元信息

- **日期**: 2026-10-02
- **类型**: MODIFY（删除废弃包）
- **状态**: archived（2026-10-02 完成并归档；apply 已合并回 `openspec/specs/`，实测验收见 tasks.md）
- **影响 spec**: `webui-system`（状态 → 删除/归档）、`alysia-architecture`（目录树）、`alysia-console`（§8 三约束）

## 动机（为什么做）

`packages/webui`（Vue 版旧前端）**自 2026-09-24 起已被 `packages/console` + `alysia-console` 取代**，
`openspec/specs/index.md` 里它的状态早已标成 `active（**待废弃**）`、
`drop-electron-desktop/proposal.md` 决策 4 当时明确写「不整体删除；Live2D 迁完再开 change 删 webui」。

**而那个 change 从来没开过。** Live2D 已于 9-25 迁出（`migrate-live2d-to-console`）、
Electron 壳已删（`drop-electron-desktop`）、`console-local-serve` 已把静态托管切到 console ——
**三个删除约束全部解除，但删除动作没人做**，于是它一直挂在那儿。

## ⚠️ 这不是"纯删"（HANDOFF 已提醒）

真实耦合点（`docs/HANDOFF.md` 原话 + 审计补充）：

1. **`server.ts` 的 `defaultDist`** —— 静态托管仍可能回落到 webui 的 dist
2. **`bootstrap.ts` 的 `IS_DESKTOP` 分支** —— `ALYSIA_DESKTOP=1` 仍分流到 webui
   （`环境速查`：服务模式 → console；`ALYSIA_DESKTOP=1` → webui（UI-only，已无 Electron 壳））
3. **webui 侧 Live2D / 模型 / 署名残留** —— 迁移只搬了 console 需要的，
   老包里的 `NOTICE` 等仍在
4. **`webui-system` spec 本身** —— 删包要同步处理该 spec 的去向（归档？冻结？）
5. **配置项**：`config.yml` 里与 webui 相关的键（若有）需要一并清理

## 需求（做什么）

- [ ] 先**逐一确认上面 5 个耦合点**的现状（**别信文档，去读代码**）
- [ ] 决定 `webui-system` spec 的去向（建议：状态改 `frozen` 并注明"已由 alysia-console 取代，包已删除"，
      或整节移入 `openspec/archive/`）
- [ ] 删除 `packages/webui` + 清理 `IS_DESKTOP` 分流与 `defaultDist` 回落
- [ ] 确认 `pnpm -r build` / 根 vitest（`test.projects`）不再引用该包
- [ ] 更新 `alysia-architecture` 目录树 + `index.md` + `HANDOFF.md`
- [ ] 若 `webui-visual-redesign` 彻底作废，**在同一批里把它标 `superseded`**

## 对账方向

- **doc 已声明（"待废弃"）→ impl 未做** → **改 impl，不改 doc**。
  把"待废弃"改成"已废弃"是结果，不是替代。

## ⚠️ 动手前的提醒

- **删除前先做一次 `grep -r webui`**（排除 node_modules / dist），确认没有隐式依赖
- **别只删目录**：`server.ts` 那两条回落路径不处理，删完会得到"白屏且无报错"
  （与 `consoleDist` 那类坑同形——**静默不注册静态路由**）
