# Spec: webui-system（新建，2026-08-15，change: webui-frontend-shell）

# WebUI 系统 — 设计文档

> 主 spec:docs/WebUI-PRD.md 为产品文档;本 spec 记录已实现的系统契约。

## 1. 形态

Vue 3 + Vite + Pinia + vue-router(hash)SPA,`packages/webui/`;
生产由 server Fastify 同源托管 dist,dev 用 vite(5173)代理 /api → 6185。
一期聊天模式:M1-M3(骨架/管理面板/聊天视图);M4 Electron 壳 + Live2D 见下一 change。

## 2. 主题系统

- `src/theme/tokens.css`:`--aw-*` 语义别名(星穹紫金 stardust 默认/晨光 dawn/午夜 midnight),
  `data-theme` 切换 + localStorage;组件只消费别名,不写字面颜色
- 三栏布局:侧栏(导航模块表)/顶栏(连接状态/角色/亲密度/主题切换)/内容区

## 3. 扩展点(PRD §8)

- `src/modules.ts`:导航模块表(id/title/icon/path/view)——二期编程模式加一行 + views/programming/
- `src/api/modules.ts`:按域分组 API;二期新增 programming.ts
- 通用组件池 `src/components/common/`:卡片/JSON/确认删除/空态/标签/表格 + useAsync

## 4. 管理面板(10 页)

画像/人格(参数 ±0.05 调整 + 记忆旋钮滑块)/生活(快照+事件流)/世界书(删除,source 标记)/
生活模板(删除)/角色(切换+导入 JSON)/知识库(导入+删除)/会话/Token 统计/表情包

## 5. 聊天视图

- 会话侧栏:webui: 前缀过滤,新会话/切换
- 消息流:历史(limit 100 倒序),加载更早(before 游标)
- 流式:POST /api/chat/stream SSE(chunk 逐块/done/aborted/error 帧);
  停止按钮 = AbortController 断开
- 表情包:[表情包:名字] → `GET /api/stickers/file/:name` 渲染贴图(404 静默隐藏)

## 6. 服务端集成

- 静态托管:dist/index.html(hash 路由);产物缺失静默跳过
- `GET /api/stickers/file/:name`:findSticker → 读文件返回(带 Content-Type/Cache-Control)
