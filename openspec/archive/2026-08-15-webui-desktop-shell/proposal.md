# Change Proposal: webui-desktop-shell

## 元信息

- **日期**: 2026-08-15
- **类型**: NEW（新功能）
- **状态**: archived
- **影响 spec**: `webui-system`（M4:Electron 壳 + Live2D 全功能）

## 动机（为什么做）

PRD §2 壳分离:Electron 是主形态(本地完整实例)。M4 = Live2D 渲染层迁入 + 桌宠窗口 + Electron 壳。

## 需求（做什么）

- [x] Live2D 迁入:Cyrene 模型(9.1MB,昔涟,授权署名非商用)+ live2dcubismcore.min.js + 渲染层 7 文件(manager/mouth-sync/speaking-motion/interaction/expression-reset/focus/actions)
- [x] `Live2DCanvas.vue`:Vue 封装(init/applyZoom/交互/口型),暴露 window.live2d API,聊天视图右下角可折叠小人
- [x] `pet.html` + `pet.ts`:桌宠页独立入口(vite 多页),透明窗口加载
- [x] `packages/desktop`:Electron 壳——主进程 = AlysiaCore(本地实例,codeMode=true)+ createWebuiApp(随机端口 127.0.0.1)+ 主窗口(SPA)+ 桌宠窗口(400×500 透明/无边框/置顶 screen-saver/穿透 skipTaskbar,照抄 Cyrene)
- [x] server exports `./webui` 子路径;webui 依赖 pixi.js 7 + pixi-live2d-display 0.5.0-beta

## 设计决策

1. **桌宠窗口点击穿透**:setIgnoreMouseEvents(true, {forward:true})(照抄 Cyrene);透明区域不挡桌面
2. **一期不做动作工具**(play_live2d_action):交互点击(9 命中区)已可玩;工具注册留待 TTS 接线时一并做
3. **内嵌 Fastify 随机端口**:127.0.0.1 仅本进程窗口访问,无外部网络面
4. **模型许可**:README/footer 需署名是依七哒,不可商用

## 对账方向确认

- [ ] 与现有 spec 冲突?无——webui-system spec 追加 M4 章节
- [x] 涉及 Web API?无新增端点(pet 页走静态托管)

## 测试计划

- [x] vite build 全页(Live2D 组件 + pet 入口)通过
- [x] pnpm -r build 0 错误
- [x] core 358 + server 100 全量回归
