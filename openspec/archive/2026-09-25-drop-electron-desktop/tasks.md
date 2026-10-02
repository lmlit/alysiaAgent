# Tasks: drop-electron-desktop

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] 删 `packages/desktop/`（4 文件：main.ts / preload.cjs / package.json / tsconfig.json）
- [x] 删 console 的 `/desktop` 预览页（`app/desktop/page.tsx` + `components/desktop/`）
- [x] 删 `app-shell.tsx` 的「桌面端」导航项 + `Monitor` 图标 import
- [x] 删 `packages/console/lib/mock-data.ts` —— 删掉 desktop 页后**无任何代码引用**
- [x] 清 `lib/api/types.ts` 里指向 mock-data.ts 的注释（改为历史说明）
- [x] 清 `server/src/bootstrap.ts` 的 Electron 注释（2 处）

## 实测验收（2026-09-25）

| 项 | 结果 |
|---|---|
| `pnpm install` | ✅ `Scope: all 7 workspace projects`（原 8，desktop 已消失） |
| `pnpm -r build` | ✅ 6 个包全成功 |
| console 路由 | ✅ **6 → 5**（`/desktop` 消失） |
| `/desktop` 访问 | ✅ **404**（不再是预览页） |
| 其余 5 个路由 | ✅ 全 200 |
| 导航栏「桌面端」 | ✅ 0 处残留 |
| 回归 | ✅ 674 passed（与改动前持平，无测试引用 desktop） |

## ★ 顺带清掉的债

**`lib/mock-data.ts` 整个删除** —— 它是 v0 样例数据里**臆造字段的源头**
（说话风格多编「口语化」、情感范围多编「稳定性」、记忆旋钮编了 core 里不存在的
「情绪记忆 / 主动唤起」）。此前它只被 `/desktop` 和已重写的 `/chat` 引用，
两者都不在了，源头终结。

**`webui-system` spec §8 的过时描述** —— 它写桌面端是
「AlysiaCore(本地 userData db) + createWebuiApp(127.0.0.1 随机端口)」，
**在删除前就已与实现不符**：实际是 fork `packages/server` + 固定 6185 +
共用 `packages/server/data`。已改记为删除 + 附上"当时实际是什么"。

## Apply 任务

- [x] `webui-system` §8：整节划掉 + 记录删除理由与当时实现的真实情况
- [x] `alysia-architecture` 3 处：范围表、目录树、平台表（另顺手把「服务端、桌面端」
      改为「服务端 IM 适配器、Web 前端、dsh 插件」，把 `WebUI | Vue SPA` 改为
      「console（现行）/ webui（待废）」）
- [x] `alysia-console` §1 路由表去掉 `/desktop`；§8 的"三个约束"更新现状
- [x] 更新 `docs/HANDOFF.md`

## 遗留：废掉 webui 的约束只剩一个

| 约束 | 现状 |
|---|---|
| Electron 壳 | ✅ 已删（本 change） |
| `pet.html` 桌宠页 | ✅ 随 Electron 失去宿主，不再需要 |
| **Live2D**（`webui/src/live2d/` + 9.1MB 模型） | ⏳ 用户决定**迁往 console**，待迁移落地 |

**下一步**：`migrate-live2d-to-console` —— 迁完即可整体删除 `packages/webui`。

**注意**：Live2D 不只是 webui 的组件，它**写在她的 persona 里**
（`core/src/persona/soul.md` §356「Live2D 与聊天文字的分工」、§11「你的存在空间是…
Live2D 桌面空间」）。迁移时要同步考虑这套自我认知表述，
以及 `alysia-todo-live2d-states` 里挂着的 `play_live2d_action` 待办。
