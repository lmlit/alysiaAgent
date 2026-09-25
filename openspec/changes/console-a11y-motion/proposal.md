# Change Proposal: console-a11y-motion

## 元信息

- **日期**: 2026-09-24
- **类型**: MODIFY（可访问性修复）
- **状态**: pending（**登记在案，暂不实现**——用户 2026-09-24 明确「先记下来，先把前端能跑了」）
- **影响 spec**: `alysia-console`（§2 设计系统补可访问性约束）
- **发现于**: change `adopt-nextjs-console` 实施期间（impeccable 设计 hook 告警 → 人工核查）

## 动机（为什么做）

收编新前端时，设计 hook 对首页 hero 渐变标题报 `gradient-text`。核查后：

- hook 给的理由（"decorative rather than meaningful / common AI tell"）是**品味判断，不采纳**——
  暖金→珊瑚橘渐变 + shimmer 与整套设计语言自洽，属于设计取向，不当缺陷处理。
- 但顺着查翻出**两个实际的可访问性问题**（与渐变本身无关）：

### 问题 1（较重要）：17 处持续动画无 `prefers-reduced-motion` 守卫

```
animate-float   6 处
animate-drift   6 处
animate-shimmer 3 处
animate-breathe 2 处
```

`app/globals.css` 里这四个 keyframe **没有任何 reduced-motion 守卫**；全项目仅
`components/ripple-cursor.tsx` 内部有一个组件级 `@media (prefers-reduced-motion: reduce)`。

无限循环的 `drift`（22s 光斑漂移）+ `float`（9s 上下浮动）+ `shimmer` 对前庭功能敏感的用户
（眩晕 / 偏头痛）是实际不适源。这是可访问性缺陷，不是口味问题。

### 问题 2（边界情况）：`text-transparent` + `background-clip: text` 的失效模式

`app/page.tsx` hero 标题：

```jsx
<span className="bg-gradient-to-r from-primary via-accent to-primary
                 bg-[length:200%_auto] bg-clip-text text-transparent animate-shimmer">
```

文字颜色**完全**来自 `background-clip: text`。正常情况对比度没问题
（实测：亮金 `oklch(0.83 0.12 72)` ≈ 9.3:1，珊瑚橘 `oklch(0.72 0.13 24)` ≈ 6.8:1，均远超 WCAG AA）。
但在 **Windows 高对比度模式（`forced-colors`）** 下颜色被系统覆盖，`text-transparent`
可能让标题**完全不可见**——不是变难看，是消失。这是 `background-clip: text` 的已知坑。

## 需求（做什么）

- [ ] `app/globals.css` 增加全局 reduced-motion 守卫：对 `breathe` / `float` / `shimmer` / `drift`
      在 `@media (prefers-reduced-motion: reduce)` 下降级（**不是全关**——保留静态视觉，
      去掉位移动画；`breathe` 可保留极小幅度的透明度变化）
- [ ] 首页 hero 渐变标题加 `@media (forced-colors: active)` 兜底（`color: CanvasText`）
- [ ] 复查其余 `animate-*`（`animate-pulse` / `animate-bounce` / `animate-ping`）是否也需要守卫
- [ ] 手动验证：devtools 模拟 `prefers-reduced-motion: reduce` 与 `forced-colors: active`

## 设计决策（怎么做，含备选与取舍）

**不采纳 hook 的 `gradient-text` 告警本身。** 理由见上——那是风格取向。
若后续要改，属于独立的设计决策，不在本 change 里夹带。

**不删除动画，只降级。** 这套动画是"她还活着"的主要表达手段（见 `alysia-console` spec §2），
一刀切 `animation: none` 会丢掉设计意图。reduced-motion 的诉求是"别动"，不是"别好看"。

## 对账方向确认

- [ ] 是否与现有 spec 冲突？无——`alysia-console` §2 只声明了 4 个动效的语义，
      本 change 补充可访问性约束（doc 补，不是 impl 迁就）
- [ ] 涉及 Web API？**不涉及**

## 测试计划

- devtools 渲染模拟：`prefers-reduced-motion: reduce` 下动画降级、布局不塌
- `forced-colors: active` 下 hero 标题仍可见
- `pnpm --filter @alysia/console build` 通过
- 视觉复查：降级后页面仍"活着"（静态渐变 / 光晕保留）
