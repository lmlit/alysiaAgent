# Tasks: polish-console-surfaces

> 代码先落地（2026-10-03），本文件为 **2026-10-15 补立案**时回填。

## 实现任务

- [x] 侧栏毛玻璃：`bg-sidebar/95` + `backdrop-blur-xl` → **`bg-sidebar/80` + `backdrop-blur-2xl`**
- [x] ripple 触发阈值放宽：`dist < 42` / `t < 55` → **`dist < 26` / `t < 42`**
- [x] ripple 粒子尺寸：`18 + speed * 0.5` → **`20 + speed * 0.55`**
- [x] ripple 描边改主题变量：`oklch(0.83 0.12 72 / 0.55)` →
      **`color-mix(in oklab, var(--primary) 85%, transparent)`**（同时提高对比）
- [x] ripple 径向渐变改主题变量：写死的暖金/暖橙 →
      **`var(--primary) 30%` + `var(--accent) 14%`**
- [x] 五处都写了「为什么」（用户原话 + 真实原因），避免下次被"优化"回去

## 验证任务

- [x] `npx tsc --noEmit` 干净
- [ ] **默认主题下肉眼确认毛玻璃可见**（不是"看起来还是实心"）← 需运行验证
- [ ] **慢慢挪动鼠标 → 能出涟漪**（本次修的核心症状）← 需运行验证
- [ ] 快速划动 → 粒子不密集到卡顿（节流仍有效）
- [ ] 切到 **sakura** → 涟漪是粉紫系，**不再是暖金**
- [ ] 两套主题下涟漪描边都清晰（原 55% 在深底上"像没画出来"）

## Apply 任务

- [x] `alysia-console` §2 补：毛玻璃取值（`bg-sidebar/80` + `blur-2xl`）
- [x] `alysia-console` §2 补判准：**「效果参数必须真的能在用户那儿显现」**
- [x] 更新 `openspec/specs/index.md`
- [x] 归档到 `openspec/archive/2026-10-15-polish-console-surfaces/`

## 备注：本 change 明确不做

- **不修 `console-a11y-motion` 的 17 处持续动画** —— 本 change 只动参数与配色
- **不加"ripple 灵敏度"用户设置** —— 为一个小众手感问题引入配置项不划算
- **不把所有写死色值一次扫干净** —— ripple 是当时发现的**唯一**漏网处；
  若还有别的，应随 `add-theme-system` 的"组件只读语义变量"契约在下一次触碰时改
