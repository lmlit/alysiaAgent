# Tasks: improve-sticker-system（首版）

> 首版范围 = **只完成已有协议的使用闭环**（计划原话）。
> ★ 这是**新功能**，不是修 bug —— 所以**没有「先红后绿」**：
> 解析器是新增的纯函数，测试与实现同时写下、锁的是契约本身。这一点如实标注，不假装有红。

## 实现任务

- [x] 纯解析器：`packages/console/lib/chat/sticker-markers.ts`
      - `parseStickerMarkers(text, { streaming })` → `text | sticker` 片段
      - `stripTrailingPartialMarker(text)` → 只截**结尾**的半截标记
- [x] 解析判据**与服务端 `qq-official.ts` 对齐**：兼容全角括号 `［］` / 全角冒号 `：`
- [x] 空名字标记（`[表情包: ]`）**两边都整条消失**（服务端 `replace` 掉；console 不产片段）
- [x] 流式判据**两头收紧**：`[表` / `[表情` / `[表情包:…` 藏起来；
      `[表示同意` / `[1+1` **照常显示**
- [x] 渲染组件：`packages/console/components/chat/message-content.tsx`
      - 内联 `<img>`（固定 `h-20 w-20` + `max-w-full` + `inline-block align-middle`）
      - 回退：未知名字 / 加载失败 → `〔名字〕` 名字片（带 `data-sticker-fallback`）
      - 清单**未就绪**时不做"未知名字"判断（避免把全部表情包误判成不存在）
      - 沿用 `xilian-figure.tsx` 的 `eslint-disable @next/next/no-img-element` + 理由
- [x] 接线 `chat-room.tsx`
      - 清单**整页只取一次**（`useApi(() => stickerApi.list())`），名字集合 `useMemo` 后向下传
      - 只有**最后一条**消息可能 `streaming`（历史消息的半截标记不该被特殊对待）
      - **用户气泡不渲染标记**（协议是她发消息用的）

## 测试

- [x] `packages/console/tests/sticker-markers.test.ts`：**23 例**，覆盖
      基本解析 / 全角兼容 / 多标记 / 不重复 / 边界空白 / 名字裁剪 / 空名字，
      以及**流式的两个方向**（半截要藏、正文方括号不能吃）与 `stripTrailingPartialMarker` 判据本身

## 未做（**转成独立 backlog**，理由见 proposal）

- [ ] 按场景分组（hero 打招呼组 / 聊天共情组 / 其他）→ `improve-sticker-selection`
- [ ] 权重与冷却（避免短时间重复、避免总抽到同一张）→ 同上
- [ ] 表情包管理页（看名字、预览、启用/停用）→ 同上

## Apply 任务

- [x] A.1 合并到 `openspec/specs/alysia-console/spec.md`：**新增 §5.1.1**、
      §5.1 的「未接」行改为已接、§3 补一句「同一份清单有两种用法」
      （**对账方向**：doc 原写"未接"，impl 现在接上了 ⇒ **改 doc**，属 ratify drift）
- [x] A.2 更新 `openspec/specs/index.md`（alysia-console 行「最后变更」）
- [x] A.3 运行验证（见下）
- [x] A.4 归档
- [x] A.5 记录部署状态

## 验证记录

| 项 | 命令（workdir `packages/console`） | 结果 |
|---|---|---|
| 解析器单测 | `& E:\nodejs24\node.exe ..\..\node_modules\vitest\vitest.mjs run tests/sticker-markers.test.ts` | **23 passed** |
| console 全套 | 同上 `run`（3 个文件） | **3 files / 83 passed**（本 change 前 60，+23） |
| 类型 | `npx tsc --noEmit` | exit 0 |
| **构建** | `npx next build` | ✅ Compiled + TypeScript + **9 个静态页全部生成** |

**⚠️ 覆盖边界（不许含糊）**：本仓 console **没有 React 组件测试**（无 RTL）。
所以「图片被渲染成 `<img src=/api/stickers/file/:name>`」这件事**没有自动化断言**，
靠：① 解析器 23 例（逻辑层）+ ② `next build` + ③ 既有页面路径。
要把它变成自动化断言，需要先给 console 引入组件测试基建 —— **那是独立决定，不夹带在这里**。

**环境备注**：`npx vitest`（Node 20）在 console 下会因
`std-env` 的 `ERR_REQUIRE_ESM` **加载不了 `vitest.config.ts`**（vitest 4 的 CJS 加载器问题）。
**这是既有问题、与本次改动无关**；用 `E:\nodejs24\node.exe` 跑则正常（60 → 83 均通过）。

## 部署状态

**未部署。** 只改前端代码与契约。

⚠️ **生效方式与 server 不同**：console 是独立前端产物，需要
`pnpm --filter @alysia/console build` 后由 server 静态托管（见 `alysia-console` §7）；
**本轮只做了本地构建验证，没有部署**。
