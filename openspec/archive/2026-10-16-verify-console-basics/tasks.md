# Tasks: verify-console-basics

> 计划 §四 的「基本验证」项。**只加测试与记录，不改产品代码。**

## 实现任务

- [x] 新增 `packages/console/tests/theme-contract.test.ts`（**17 例**）
- [x] **跨文件一致性**（本 change 的主要价值）：
      - `layout.tsx` 内联脚本与 `THEME_STORAGE_KEY` **逐字一致**
      - 每个 `THEMES.id` 在 `themes.css` 都有 `[data-theme='<id>']` 块
      - `swatches.primary/accent` 必须**出现在 CSS 里**（色卡不许骗人）
      - 每套主题恰好一个 `--primary` + 一个 `--accent`
- [x] `getTheme/setTheme` 的回落语义：无值 / 旧 id / 非字符串 / storage 抛错 → **默认且不抛**；
      `setTheme` 在 storage 被禁时 **DOM 照常生效**却返回 `false`
- [x] SSR 安全（无 `window`/`document`）
- [x] `stickerApi.fileUrl` 对空格与斜杠编码

## 明确**没做**（本环境验不了，见 proposal 的表）

- [ ] 窄屏布局（需真实视口）
- [ ] 贴纸轮换时序 / 不预载 / 不跳动（需组件测试基建或浏览器）
- [ ] `/code` 引导页的文案与 `dsh://` 按钮行为（需人工）
- [ ] 聊天里表情包渲染的交互（需浏览器）

★ 这四项**不是通过**，而是**未验证**。要推进它们需要先给 console 引入
组件测试基建（RTL / Playwright），**那是独立决定**，不在本 change 夹带。

## Apply 任务

- [x] A.1 不改 spec（本 change 不产生契约）
- [x] A.2 更新 `openspec/specs/index.md`？——**不需要**：没有 spec 变更，也因此**不进 Backlog**
- [x] A.3 运行测试（见下）
- [x] A.4 归档
- [x] A.5 记录部署状态：**不涉及**（未改产品代码，无部署动作）

## 验证记录

| 项 | 命令（workdir） | 结果 |
|---|---|---|
| 主题/贴纸契约 | `& E:\nodejs24\node.exe ..\..\node_modules\vitest\vitest.mjs run tests/theme-contract.test.ts`（`packages/console`） | **17 passed** |
| console 全套 | 同上 `run` | **4 files / 100 passed**（本 change 前 3 / 83） |
| console 类型 | `npx tsc --noEmit` | exit 0 |
| console 构建 | `npx next build` | ✅ 10 个静态页 |

**这些断言真的会红吗**（自检，防止写出永远绿的装饰性测试）：
- 「CSS 块存在」：对不存在的 id 做 `css.includes('[data-theme=…]')` 为 `false` ⇒ 断言会红 ✓
- 「键名一致」：键名一改，`layout.tsx` 里那句字面量就对不上 ⇒ 会红 ✓
- 「色标真实」：色值一改，CSS 里找不到 ⇒ 会红 ✓
- 「storage 被禁」：`setItem` 抛错时 `setTheme` 返回 `false` 是**分支行为**，不是恒真 ✓
