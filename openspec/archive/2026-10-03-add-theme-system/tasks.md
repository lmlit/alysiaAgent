# Tasks: add-theme-system

> 每个任务完成即勾选。实现过程中若发现 proposal 的判断有误，**回来改 proposal**，不要只在代码里绕。

## 1. 主题表抽取 ✅

- [x] 新建 `packages/console/app/themes.css`
- [x] 把现有 `globals.css` `:root` 的暖墨变量**整段搬入** `[data-theme="warm-ink"]`，**逐字不改值**
- [x] `:root` 保留一份同样的默认值（无 JS / 未设 `data-theme` 时仍有色，且默认即暖墨）
- [x] 新增 `[data-theme="sakura"]`，色值取自 `cyrene-assets/avatars/cyrene-avatar.png`
- [x] `globals.css` 用 `@import` 引入主题表，确认 Tailwind v4 的 `@theme inline` 仍指向这些变量
- [x] 核对 `--chart-1..5`：sakura 下同步换成紫粉系（`--chart-3/5` 保留冷色与绿色做区分度，不做成同色系）

> 色值不是凭色调的：`cyrene-avatar.png` 量化取样 → sRGB 精确转 oklch，
> 脚本与实测输出在 `.video-demo/gen-sakura-palette.py`。对比度实测已随 spec 记录。

## 2. 持久化与防闪烁 ✅（运行验证待补）

- [x] 新建 `packages/console/lib/theme/theme.ts`：主题 id 常量、列表、读写 localStorage、默认值
- [x] 先读文件确认 `app/layout.tsx` 现有结构（它已有 `<html className="dark ...">`，未覆盖）
- [x] 在 `<head>` 加**同步** inline script：读 localStorage → `document.documentElement.dataset.theme`
- [x] `<html>` 加 `suppressHydrationWarning`
- [ ] 验证：清空 localStorage / 存了非法主题 id / 存了 `sakura`，三种情况都不报错且表现正确 ← **需运行**

> 内联脚本刻意**不做白名单校验**：非法 id 在 CSS 里没有对应块，自动落回 `:root`，
> 天然安全，也就不必在脚本里维护一份 id 列表（少一处会漂移的副本）。

## 3. 设置页 ✅

- [x] 新建 `packages/console/app/settings/page.tsx`
- [x] 主题选择器：两套主题的**可视预览卡**（各用自己主题的真实色值渲染色块），不是纯文字下拉
- [x] 切换即时生效（不刷新页面）
- [x] 接入 `AppShell`（侧栏导航加「设置」项）
- [x] 页面标题与 metadata 对齐现有页面风格（沿用 root layout 的，与 `/life` 一致）

> 选择器等**挂载后**才读当前主题：服务端没有 localStorage，放进 `useState` 初值会造成
> hydration mismatch。首屏防闪由 layout 的同步脚本负责，不依赖这里。

## 4. 验证

- [x] `npx tsc --noEmit` 干净（exit=0）
- [x] **默认主题下与改动前逐项核对色值**（不得有任何一处的值被顺手改动）
      ★ **2026-10-15 机器验证通过**：脚本比对 `HEAD:app/globals.css` 的 `:root` 与
      `themes.css` 的 `:root, [data-theme='warm-ink']` ——
      **31 个色值逐字一致，0 改动 0 丢失**。
      唯一"消失"的 `--radius = 0.9rem` 经查**仍在 `globals.css:84`**，
      且**位置正确**（形状 token 属设计系统规则，不是主题数据）。
      脚本：`.tools/verify-theme-parity.mjs`
- [ ] 两套主题 × 5 个路由 + `/settings` 逐页检查 ← **需视觉验证**
- [ ] loading / error / empty 态检查（`components/states.tsx`）← **需视觉验证**
- [ ] 首屏无闪烁：硬刷新 5 次 + 限速网络 ← **需视觉验证**
- [x] sakura 下正文 / muted / 边框对比度 ≥ WCAG AA（记录实测值）
      ★ **2026-10-15 独立复核**：自己实现 oklch→linear sRGB→WCAG 对比度重算，**与注释声称值逐项吻合（差 ≤0.01）**：
      ```
      sakura：正文 16.23 · 次要文字 7.85 · 主色 7.58 · 强调 5.95 · 卡片文字 13.92  → 全部 ≥ AA 4.5:1 ✅
      ```
      ⚠️ **同时查出一处错误**：注释里作为对照的**暖墨那组（14.06 / 6.08 / 8.74 / 5.01）
      用同一套方法复现不出来**（sakura 精确命中说明方法没问题 → 是那组数字有问题，
      疑似混用了不同参照背景）。已改用同一口径的实测值：
      `正文 16.05 · 次要文字 7.70 · 主色 11.15 · 强调 7.30 · 卡片文字 14.71`。
      **结论不变：两套主题全部 ≥ AA。**
      脚本：`.tools/verify-contrast.mjs`
- [ ] `prefers-reduced-motion` 与 `forced-colors` 下不引入回归（见 pending change `console-a11y-motion`，**本 change 不夹带修它**）

> 剩余项都要把页面跑起来看。本机沙箱下 `next dev` / Chromium 都需提权，
> 且 `tsconfig.tsbuildinfo` 写不进去（已知坑），届时用 `--tsBuildInfoFile` 指向可写路径。
>
> ★ **2026-10-15 补记**：可脚本化的两项（色值等价、对比度）**已用机器验证完成**，
> 不再依赖"肉眼核对"。剩下的三项（逐页观感 / 三态 / 防闪）本质上需要真实渲染，
> **仍未验证**——发布前应知情。

## 5. spec 合并与归档

- [x] `alysia-console` §2：暖墨从「唯一色板」改写为「默认主题」，补多主题契约（含"每套主题内仍单强调色"）
      —— 实为 **8 条契约**（后 2 条由同批 change 贡献：契约 7 外链裸 `<a>`、契约 8 效果可见性）
- [x] `alysia-console` §5：新增 `/settings` 页面契约一行
- [x] 更新 `openspec/specs/index.md` 的 `alysia-console` 行
- [x] 归档（`openspec/archive/2026-10-03-add-theme-system/`）

> ★ 归档时（2026-10-15）同批并入 **5 个补立案的 change**（代码均于 2026-10-03 先落地）：
> `sticker-figure` / `code-mode-entry` / `rewrite-console-voice` /
> `polish-console-surfaces` / `fix-next-dev-cross-origin` —— 见各自 archive 目录。
> 另：本 spec 新增了 **§2.1 文案口吻契约**（由 `rewrite-console-voice` 贡献）。

