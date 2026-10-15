# Tasks: code-mode-entry

> 代码先落地（2026-10-03），本文件为 **2026-10-15 补立案**时回填。

## 实现任务

- [x] 新建 `packages/console/app/code/page.tsx`：server component thin wrapper（与 `/life` 同构）
- [x] 新建 `packages/console/components/code-entry.tsx`（'use client'）：
      徽标「编程模式」+ 标题「换个地方，我接着帮你做事」+ 说明 + **`dsh://` 按钮** + 失败兜底提示
- [x] 形象沿用 `XilianFigure`（表情包轮换）——换页也还是她
- [x] 环境光与首页同一套手法（`animate-drift` + primary/accent 模糊球），保证两页观感连贯
- [x] 侧栏 `nav` 新增 `{ href: '/code', label: '编程模式', icon: Code2 }`
- [x] `NavItem` 增加 `external?: boolean`；外部项渲染**裸 `<a>`**、**不参与高亮**
- [x] 写清"为什么不从侧栏直接跳 `dsh://`"与"人格记忆不归本页管"两处注释

## 验证任务

- [x] `npx tsc --noEmit` 干净
- [ ] 侧栏「编程模式」→ 落到 `/code`，**不出现 `/dsh://` 404** ← 需运行验证
- [ ] 已装 dsh 的机器：按钮唤起应用；未装的机器：**留在原页**并显示提示 ← 需人工验证
- [ ] 窄屏布局正常 ← 并入 `add-theme-system` 的逐页检查
- [ ] sakura 主题下配色正常 ← 同上

## Apply 任务

- [x] `alysia-console` §5 新增 `/code` 页面契约
- [x] `alysia-console` §2 补「侧栏 external 项渲染裸 `<a>`，否则 `dsh://` 被当站内路由 → 404」
- [x] 更新 `openspec/specs/index.md`
- [x] 归档到 `openspec/archive/2026-10-15-code-mode-entry/`

## 备注：本 change 明确不做

- **不实现人格/记忆通道** —— 归 `dsh-adapter`（见其 spec）
- **不做 dsh 安装检测** —— 引导页只说"点了没反应多半是没装"，**不主动探测协议可用性**
  （浏览器无法可靠查询自定义协议是否注册；主动探测要靠隐藏 iframe + 超时，成本高于收益）
