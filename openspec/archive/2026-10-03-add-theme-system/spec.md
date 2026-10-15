# Spec 变更: add-theme-system

> **apply 说明**：本 change 改 `alysia-console` 的**两处**：
> ① **§2 设计系统** —— 改写首段（"唯一色板" → "可扩展主题表"），并追加**多主题契约**；
> ② **§5 页面契约** —— 追加 `/settings` 一行。
>
> 下面按「改写」与「追加」分段标注，**改动位置都以现有 spec 的行号为锚**（以 2026-10-03 的
> `openspec/specs/alysia-console/spec.md` 为准）。
>
> ⚠️ 依旧**不使用 `+`/`-` diff 标记**（纯新增内容不留标记，理由见 `clean-spec-diff-residue`）。

---

## 一、§2 改写：首段

**位置**：`alysia-console/spec.md` §2 第 1 行（现为「单一事实源 `app/globals.css`，oklch "暖墨"（Warm ink）色板：」）。

**原文**：

> 单一事实源 `app/globals.css`，oklch "暖墨"（Warm ink）色板：

**改写为**：

> 单一事实源 `app/themes.css`（由 `app/globals.css` @import）。**色板是可扩展的主题表**，
> 每套主题一份 CSS 变量，挂在 `<html data-theme="<id>">` 上；默认主题 `warm-ink`。
> 新增主题 = 多一份变量，**不改任何组件**（组件一律只读语义变量，如 `var(--primary)`）。
>
> **默认主题 `warm-ink`（暖墨）**：

---

## 二、§2 追加：多主题契约

以下为追加内容（**接在 §2 现有「禁止引入」那行之前**）
---

**契约 1：主题是数据，设计系统是规则 —— 两者分文件。**

`app/themes.css` 只放主题的变量值；`app/globals.css` 放规则（`@theme inline` 映射、
`@layer base/utilities`、动效 keyframes）。主题表由 `globals.css` `@import`。

**契约 2：每套主题内部仍严格只有一个 primary + 一个 accent。**

§2 原有的「禁止多色强调」**继续有效**，它约束的是**单套主题内**的强调色数量。
新增主题**不是**放松这条约束的借口 —— 换的是整套色板，不是往一套里塞更多颜色。

**契约 3：主题 id 是持久化契约。**

`warm-ink` / `sakura` 会被写进用户浏览器的 localStorage。**改名等于让所有已存的用户
回落到默认**（且不报错、无提示）。显示名随便改，**id 只增不改**。
（同类教训见 dsh 的 preset id 事故：改名让 16 个会话全废。）

**契约 4：默认主题必须是 `warm-ink`，且其色值不得被顺手改动。**

默认主题是"不惊扰现状"的保证线。任何改动默认主题色值的行为都要单独开 change 说明理由，
**不得夹带在"添加主题"里**。

**契约 5：首屏不得闪烁（no-FOUC）。**

主题在**首次绘制前**就要定下：在 `app/layout.tsx` 的 `<head>` 内联**同步**脚本读
localStorage 并设 `data-theme`，`<html>` 带 `suppressHydrationWarning`。
在 `useEffect` 里设主题**不合格**——用户会看到一次变色。

**契约 6：新增主题必须提供对比度实测值。**

每套主题的正文 / muted / 边框在自身背景上**均须 ≥ WCAG AA**，实测值随 change 记录。
不得只靠"看着还行"。

---

## 三、§5 追加：设置页

以下为追加内容（**接在 §5「已接入真实数据」列表的 `/`（landing）一行之后**）
---

- `/settings`：**设置页**（2026-10-03 `add-theme-system`）。首项为主题切换，两套主题以
  **可视预览卡**呈现（各用自己的色板渲染小色块，而非纯文字下拉），切换**即时生效不刷新**。
  选择持久化于 localStorage（键与主题表见 `lib/theme/theme.ts`）。
  页面自身也受主题影响 —— 即"在 sakura 下开着设置页切回 warm-ink"必须能正常观察到自己。

---

## 明确不涉及

- **不改任何现有色值** —— 默认主题 `warm-ink` 的每一个值都逐字保留（契约 4）
- **不碰 `console-a11y-motion`** —— 那是 pending change（17 处动画缺 reduced-motion 守卫），
  **不夹带**、不顺手补、不改它的文件
- **不做表情包渲染** —— 归 `wire-sticker-rendering`（本 change 之后的独立 change）
- **不动 Live2D** —— 其停用归 `wire-sticker-rendering`
- **不引入主题"跟随系统"** —— 用户 2026-10-03 明确选了「可扩展主题表 + 设置页手动切」，
  自动跟随不在本次范围
