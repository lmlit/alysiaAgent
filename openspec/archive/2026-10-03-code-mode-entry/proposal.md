# Change Proposal: code-mode-entry

## 元信息

- **日期**: 2026-10-03（代码先落地，**2026-10-15 补立案**）
- **类型**: NEW（新增页面 + 侧栏基础设施）
- **状态**: archived（代码已实现并通过 `tsc`；待补 spec 合并与归档）
- **影响 spec**: `alysia-console`（§5 页面契约新增 `/code`；§2 侧栏导航行为）
- **补立案原因**: 本 change 的代码在 `packages/console/` 里已完工，代码注释自称
  `change: code-mode-entry`，但 `openspec/changes/` 与 `archive/` 下**都查无此案** ——
  即 CLAUDE.md 明令禁止的「直改不 archive」。本次补齐。

## 动机（为什么做）

`packages/specs` 记载编程模式**由 dsh（DeepSeek Harness 桌面应用）承接**
（见 `openspec/specs/dsh-adapter/spec.md`）。console 侧要做的只有一件事：**把人送过去**。

但"送过去"没那么简单。原先侧栏若直接挂 `dsh://`：

1. **没装 dsh 的机器上点了毫无反应** —— 用户看到的是"按钮坏了"，而不是"我还没装"。
   自定义协议未注册时，浏览器不会有任何提示。
2. **跳出去之后没有任何解释** —— 人不知道自己被送到了哪、为什么是这里。
3. **`<Link>` 会把 `dsh://` 当站内路由** —— 跳到 `/dsh://` 然后 404（Next 的 Link 只认站内）。

所以需要一个**站内引导页**：侧栏指向它，它负责说清三件事 —— **去哪儿 / 为什么去 / 没装怎么办**。

## 需求（做什么）

- [x] 新建 `packages/console/app/code/page.tsx`：server component 的 thin wrapper（与 `/life` 同构）
- [x] 新建 `packages/console/components/code-entry.tsx`：引导页正文（'use client'）
      —— 标题、说明、**真正的 `dsh://` 按钮**、以及"点了没反应怎么办"的提示
- [x] 侧栏 `nav` 新增 `{ href: '/code', label: '编程模式' }`，**指向站内页而非 `dsh://`**
- [x] 侧栏基础设施：`NavItem` 增加 `external?: boolean`；外部项渲染**裸 `<a>`** 而非 `<Link>`，
      且不参与当前页高亮

## 设计决策（怎么做，含备选与取舍）

### 1. 侧栏指向站内引导页，`dsh://` 按钮放在那一页上 ✅

**why**：侧栏是"导航"，用户点它时的心智是"我要去这个页面"。把一个**可能无反应**的自定义协议
放在导航位，失败时没有任何反馈渠道。放到引导页上，失败提示可以**紧挨着按钮**。

**被否决**：侧栏直接挂 `dsh://` —— 即原先的做法，见动机三条。

### 2. `external` 是 `NavItem` 的一个字段，而不是"看到 `://` 就判断" ✅

**why**：判断式的隐式行为（`href.includes('://')`）会把"是不是外链"这件**意图**藏在字符串格式里；
显式字段让下一个加外链的人不必猜规则。渲染分支也因此是**穷尽的**（`item.external ? <a> : <Link>`）。

### 3. 人格与记忆的通道**不归本页管** ⚠️

引导页文案提了一句"平时攒下的记忆和脾气，那边一样认得你"——那是**承诺**，
由 `dsh-adapter` 侧的四层通道（人格/记忆读/记忆写/结算）兑现，见
`openspec/specs/dsh-adapter/spec.md`。**本 change 只负责"把人送过去"**，
不实现也不验证那条通道。

### 4. 页脚文案明确给出**失败兜底** ✅

> 「它会以独立窗口打开。要是点了没反应，多半是这台机器还没装——那就先在这儿聊着，人家也不催你。」

**why**：引导页的价值一半在"告知"，一半在**"失败了怎么办"**。只写"点击打开"等于把问题推回给用户。

## 对账方向确认

- [x] 与现有 spec 冲突？**否，是新增**。`alysia-console` §5 页面契约需要新增 `/code` 一行；
      §2 需要补「侧栏 `external` 项渲染裸 `<a>`」这条行为（否则下一个人会踩同一个 404 坑）
- [x] 涉及 Web API？**不涉及**（纯前端路由与组件）
- [x] 涉及 core / server？**不涉及**

## 测试计划

- [x] `npx tsc --noEmit` 干净（随 `add-theme-system` 一并跑过）
- [ ] 侧栏「编程模式」→ 落到 `/code`，**不出现 `/dsh://` 404** ← 需运行验证
- [ ] 点「打开 DeepSeek Harness」→ 已装 dsh 的机器唤起应用；未装的机器**保持原页面**并展示提示
- [ ] `/code` 在另一套主题（sakura）下配色正常 ← 与 `add-theme-system` 的逐页检查合并做
- [ ] 移动端窄屏布局正常

## 交付后的收尾

- [ ] 合并进 `openspec/specs/alysia-console/spec.md` §5（`/code` 页面契约）+ §2（侧栏外链行为）
- [ ] 更新 `openspec/specs/index.md` 的 `alysia-console` 行
- [ ] 归档到 `openspec/archive/2026-10-15-code-mode-entry/`
