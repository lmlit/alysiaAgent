# Change Proposal: add-theme-system

## 元信息

- **日期**: 2026-10-03
- **类型**: ADD（新能力）
- **状态**: pending
- **影响 spec**: `alysia-console`（§2 设计系统 → 泛化为多主题；§5 页面契约 → 新增 `/settings`）
- **发现于**: 用户 2026-10-02 提出「现在前端和昔涟颜色不对」

## 动机（为什么做）

### 问题：产品色与形象色是两套，且都改不动

console 现行的单一色板是 `globals.css` 的 oklch「暖墨」——暖炭灰底 `oklch(0.17 0.014 55)`
配暖金 `oklch(0.83 0.12 72)`。而产品形象「昔涟」的立绘与 52 张表情包是**粉紫系**
（粉 `#E294D1` / 紫 `#AB92CC` / 深紫 `#413368`）。两者并置时不协调，用户明确反馈"颜色不对"。

但现状**换不掉，也换不了一半**：

- 色值**硬编码**在 `:root`，是全站唯一事实源（spec §2）。改它就是"换掉"，不是"并存"
- 组件全部通过 `var(--primary)` 这类语义变量取色 —— 这是**优点**（所以有做主题的底子），
  但也意味着**没有第二个取值来源**
- 用户要的不是单向替换，而是**主题切换**

### 为什么不做成"直接换成粉紫"

那会让「暖墨」这套已验收的视觉资产作废（`alysia-console` §2 整节、以及宣传片已经按它
定的视觉方向）。**主题切换能同时保住两套**，且以后加第三套只加一份变量。

### 为什么顺带建设置页

主题切换需要一个入口，而项目当前**没有任何设置页**。与其把开关塞进顶栏挤一个图标位，
不如建一个设置页 —— 后续的偏好项（称呼、通知、语言）都有地方放。

## 需求（做什么）

- [ ] 把 `:root` 的 CSS 变量抽成**可扩展主题表**：新增主题 = 多一份变量，**不动任何组件**
- [ ] 落两套主题：`warm-ink`（现状暖墨，**保持为默认**）、`sakura`（粉紫，取自昔涟立绘/表情包）
- [ ] 新建**设置页** `/settings`，主题切换为其第一项
- [ ] 选择持久化到 localStorage，且**首屏不闪烁**（无 FOUC）
- [ ] `AppShell` 侧栏加入口
- [ ] 默认主题下，视觉与改动前**逐项一致**（不惊扰现状）

## 设计决策（怎么做，含备选与取舍）

### 1. 切换机制：`<html data-theme>` + CSS 变量覆盖 ✅

```css
[data-theme="warm-ink"] { --background: oklch(0.17 0.014 55); ... }
[data-theme="sakura"]   { --background: oklch(...); ... }
```

**备选与否决理由**：

| 备选 | 否决理由 |
|---|---|
| 多个 class（`.theme-warm` / `.theme-sakura`） | 与 `data-theme` 等价，但后者语义更明确，且便于未来用属性选择器做"主题 × 明暗"组合 |
| CSS-in-JS / 内联 style | 引入运行时开销，不利于 SSR，且与现有 Tailwind v4 + `@theme inline` 体系冲突 |
| 只覆盖 `--primary` / `--accent` 两三个变量 | **不够**。背景、卡片、边框、muted 都要跟着变，否则会出现"粉字配暖灰底"的脏色 |

### 2. 主题表独立成文件 ✅

新建 `app/themes.css`，由 `globals.css` `@import`。

理由：`globals.css` 已 147 行，再塞两套完整主题（每套约 40 行变量）会长到难读。
主题是**数据**，设计系统是**规则**，两者分开。

### 3. 默认主题 = `warm-ink` ✅

不突然改变现有观感。`sakura` 是**选项**，不是新默认。

### 4. 防闪烁：root layout 内联脚本 ✅

在 `app/layout.tsx` 的 `<head>` 塞一段**同步** inline script：读 localStorage → 设
`data-theme` → 再让 React 接管。配合 `<html suppressHydrationWarning>`。

这是 Next.js 下的标准做法。**备选**（`useEffect` 里设）会在首帧后变色，用户能看见闪烁 —— 否决。

### 5. 与 spec §2「禁止多色强调」的对账 ⚠️

spec §2 原文写「禁止引入：霓虹 glow 阴影、**多色强调**、无意义动画」。

**该禁令约束的是**：**同一套主题内**不得堆多个强调色（形成花哨）。
**本 change 做的是**：整体换一套色板，**每一套主题内部仍严格只有一个 primary + 一个 accent**。

→ 属于**泛化**，不是推翻：§2 从"唯一色板"升级为"多主题，每套遵守同一约束"。
不存在"把它降级迁就现状"的方向问题。

### 6. sakura 主题的取色来源

从 `cyrene-assets/avatars/cyrene-avatar.png` 量化取样（深紫 `#413368` / 亮紫 `#AB92CC` /
粉 `#E294D1` / 浅粉 `#EBCBE2` / 近白 `#FDF9FC`），沿用与横幅同一套取样方法。

转换到 oklch 后仍需**逐项核对对比度**：正文、muted、边框在深紫底上必须满足 WCAG AA
（§2 现有的暖墨色板实测约 9.3:1 / 6.8:1，sakura 不得低于 AA）。

## 对账方向确认

- [ ] 是否与现有 spec 冲突？**无**——§2 的暖墨色板从「唯一」变为「默认主题之一」，
      是能力泛化（doc 补多主题契约），不是把 spec 降级迁就实现
- [ ] 涉及 Web API？**不涉及**（纯前端，不动 `docs/Web-API-Design.md`）
- [ ] 涉及 core / server？**不涉及**

## 测试计划

- `npx tsc --noEmit` 干净
- **默认主题（warm-ink）下与改动前逐项核对色值**——这是"不破坏现状"的验收线
- 两套主题下逐页检查 5 个路由（`/` `/chat` `/life` `/personality` `/dashboard`）+ 新 `/settings`
- **loading / error / empty 态也要检查**（`components/states.tsx`），暗色主题互换时最易出不可读
- 首屏无闪烁：硬刷新 5 次 + 限速网络模拟
- localStorage 持久化；清空 localStorage 后回落到默认主题且不报错
- 对比度实测：sakura 下正文/muted/边框 ≥ AA

## 交付后的收尾

- 合并进 `openspec/specs/alysia-console/spec.md` §2（多主题契约）与 §5（`/settings` 页面契约）
- 更新 `openspec/specs/index.md` 对应行
