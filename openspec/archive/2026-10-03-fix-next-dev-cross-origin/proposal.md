# Change Proposal: fix-next-dev-cross-origin

## 元信息

- **日期**: 2026-10-03（代码先落地，**2026-10-15 补立案**）
- **类型**: FIX（开发环境配置）
- **状态**: archived
- **影响 spec**: **不涉及 spec**（开发环境配置，不影响产品契约）
- **补立案原因**: 与 `code-mode-entry` 等同一批改动的第 6 件，未立案。
  为一行配置单独立案看似过重，但**它修的是一个真实发生过的误判**，
  值得留下记录（否则下一个人会在同一处再绕一圈）。

## 动机（为什么做）

**Next 16 默认拦截跨源 dev 资源**：用 `http://127.0.0.1:3000` 打开 dev server 时，
所有 JS chunk 被 block，页面变成**「没有 JS 的空壳」**。

表现是：**数据永远停在「加载中」** —— 看起来跟"接口挂了"一模一样。

代码注释记录了这次误判的代价：

> 「实测踩过：**一整轮的截图与验证都是在 JS 被拦的状态下做的**，
> 还把现象归给了'后端慢'。」

**这是本 change 的全部价值**：它把一个**错误的归因**钉死在了配置层。

## 需求（做什么）

- [x] `packages/console/next.config.mjs` 增加 `allowedDevOrigins: ['127.0.0.1']`

```js
// ★ Next 16 默认拦截跨源 dev 资源：用 127.0.0.1 打开时所有 JS chunk 被 block，
//   页面变成「没有 JS 的空壳」—— 数据永远停在「加载中」，看起来跟接口挂了一模一样。
allowedDevOrigins: ['127.0.0.1'],
```

## 设计决策（怎么做，含备选与取舍）

### 1. 显式放行 `127.0.0.1`，而不是"改用 localhost" ✅

**why**：`localhost` 与 `127.0.0.1` 都是常用入口。只解决一个等于把坑留给下一次
——**下一个用 127.0.0.1 的人会重新踩一遍**（而且大概率又会归因到后端）。

**被否决**：文档里写一句"请用 localhost" —— 依赖人记住，而这类坑的特征正是"看起来不像配置问题"。

### 2. 为什么不把它并进某个前端 change ✅

它**不属于任何前端功能**：`add-theme-system` / `sticker-figure` / `code-mode-entry` 都不涉及 dev server 配置。
单独立案虽然小，但**归属清晰**（下一个查"dev 资源为什么被拦"的人会搜到它）。

### 3. 为什么不需要 spec ✅

**判断依据**：spec 描述的是**产品契约**（形态 / 设计系统 / API / 页面），
而 `allowedDevOrigins` **只影响 `next dev`，不进生产构建** —— 打包产物与它无关。
故本 change 的 spec 增量为**空**，这是**有意的**，不是漏写。

## 对账方向确认

- [x] 与现有 spec 冲突？**否，且不涉及 spec**（见设计决策 3）
- [x] 涉及 Web API？**不涉及**
- [x] 涉及 core / server？**不涉及**

## 测试计划

- [ ] 用 `http://127.0.0.1:<port>` 打开 dev server → **JS chunk 不再被拦**，
      页面有交互（不再停在「加载中」）← 需 `next dev` 运行验证
- [ ] 用 `http://localhost:<port>` 打开 → 行为不变（无回归）
- [ ] **生产构建不受影响**：`pnpm build:console` 产物与改动前一致（该字段不进生产）

## 交付后的收尾

- [ ] 无 spec 合并（本 change spec 增量为空）
- [ ] 更新 `openspec/specs/index.md` 的 `alysia-console` 行（记账即可）
- [ ] 归档到 `openspec/archive/2026-10-15-fix-next-dev-cross-origin/`
