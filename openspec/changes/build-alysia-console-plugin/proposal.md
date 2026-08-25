# Change Proposal: build-alysia-console-plugin

> 把 alysia 管理面板迁移为 dsh 插件形态——「昔涟控制台」,模仿 dsh-whale-widget 的
> bundle 单包 + webServer 注入机制(已逆向分析确认)。
> 调研背景:dsh-web 生态(皮肤系统 278 token / dsh-pet / 鲸鱼余额挂件)见会话记录。

## 元信息

- **日期**: 2026-08-26
- **类型**: NEW(新功能)
- **状态**: proposed
- **影响 spec**: `dsh-adapter`(扩展,新增 §6 昔涟控制台)

## 动机(为什么做)

用户确认:窗口端已砍,dsh 是唯一前端载体;但昔涟的管理能力(画像/会话/世界书/生活模板/记忆旋钮/审计)仍在 alysia server(6185)里,缺少 dsh 内的控制台入口。社区参考已逆向确认可行:
- **dsh-whale-widget**:`inject: ['webServer']` + `webServer.register()` 托管 `/xxx/widget.js` + `webServer.tapIndex()` 向 index.html 注入 `<script>`——标准 bundle 单包即插即用,自启、皮肤跟随
- **skin-center**:278 个 `--dsw-alias-*` token 可覆盖,皮肤跟随零成本
- **dsh-web-all**:聚合包先例(但子包 hoist 有坑,单包更稳)

## 需求(做什么)

- [ ] 新包 `packages/dsh-console`(标准 dsh bundle 单包,仿 dsh-whale-widget 骨架)
- [ ] host 侧:`ctx.webServer` 托管 `/alysia-console/*`(静态资源 + widget 入口)+ **同源 API 反代**(`/alysia-api/*` → `127.0.0.1:6185/api/*`,规避 alysia server 无 CORS)+ `tapIndex` 注入
- [ ] client 侧:昔涟控制台(Vue 3 + Vite 打包为静态 bundle)——入口为悬浮按钮/侧边按钮,展开管理面板
- [ ] 面板功能(迁移自 alysia webui 管理页,数据全走 6185 现有端点):画像 / 会话管理(归档/删除)/ 世界书 / 生活模板 / 记忆旋钮(adjustMemoryConfig)/ 审计
- [ ] 皮肤联动:控制台样式全部用 `--dsw-alias-*` token(默认值回退),跟随当前皮肤
- [ ] `session/event` 监听:每轮对话消耗统计(可选,参考鲸鱼)
- [ ] 验收:dsh web 里可打开昔涟控制台;画像/会话/世界书读写生效;换皮肤控制台同步变色

## 设计决策(怎么做,含备选与取舍)

1. **形态 = 标准 bundle 单包**(仿 dsh-whale-widget),放 `packages/dsh-console`
   → 单包无子依赖,规避 dsh-web-all 的 pnpm hoist 坑;被否决:并入 `packages/dsh-adapter`(职责混杂,preset 插件 vs host 插件分层不同)
2. **API 访问走同源反代**(host 侧 `/alysia-api/*` → 6185)
   → alysia server 的 Fastify 未开 CORS,浏览器直连 6185 会跨域挂;反代后 client 同源,且以后切域名/端口只改一处。被否决:给 6185 加 CORS(动 server 配置,且暴露端口)
3. **UI 用 Vue 3 + Vite 打包**(与现有 webui 同栈),产物作为插件静态资源
   → 管理页组件可整体搬运;被否决:鲸鱼式单文件 IIFE(控制台是完整 SPA 级 UI,IIFE 不可维护)
4. **入口 = 悬浮/侧边按钮,非独立路由**
   → 融入 dsh web 界面(仿鲸鱼常驻);控制台面板为抽屉/弹层
5. **一期只迁管理面板**,聊天 UI 用 dsh 原生(会话列表/聊天视图 dsh 已有)
6. **不涉及 core 改动**:全部复用 6185 现有端点(对照 `docs/Web-API-Design.md` 状态标记)

## 对账方向确认

- [x] 是否与现有 spec 冲突?无 → 扩展 `dsh-adapter` spec(新增 §6 昔涟控制台)
- [x] 涉及 Web API?是——新增反代端点 `/alysia-api/*`(映射 6185 现有 `/api/*`),对照 `docs/Web-API-Design.md`;core/server 本身**零改动**

## 测试计划

1. host 侧单元:反代路由转发(路径/方法/错误码)、tapIndex 注入去重、静态托管存在性
2. 手动:dsh web 打开 → 控制台按钮 → 面板各页数据加载(画像/会话/世界书/旋钮改后 server 生效)→ 换皮肤控制台变色
