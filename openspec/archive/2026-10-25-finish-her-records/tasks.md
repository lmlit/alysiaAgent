# Tasks: finish-her-records

## 实现
- [x] `maybeDailyReflection`：context 加 `【你最近写下的】`（最近 3 篇私密记录）
- [x] `GET /api/life/her-records`（kind / visibility / limit 过滤，只读）
- [x] `GET /api/life/private-diaries`（别名）
- [x] `smoke-local.mjs`：加两个端点断言（断言"接口在"，不是"有数据"）

## 测试
- [x] `life-service.test.ts` +1 例：★ 私密日记进**反思** context
- [x] 全量 **169 文件 / 1975 用例**
- [x] smoke 本地实跑：两个端点 200、`records` 是数组

## 部署
- [x] `pnpm deploy`（镜像 10698f11df93，`rollback-20261025-180808`）
- [x] 部署后验：`her-records?visibility=private` 拿到那 1 条反思；`private-diaries` 返回 `{"records":[]}`（跨天才会写）；`kind=diary&shared` 拿到公开日记
- [x] 归档到 `openspec/archive/2026-10-25-finish-her-records/`

## 明确不做
- ❌ console 页面（先给接口；界面等真要看的时候再做）
- ❌ 把私密内容注入聊天（那是表演，契约里写死了）
## ★ 又抓到一个自己的 bug（闸把自己拦下了）
smoke 明明打印"通过"，部署却被拦 —— 退出码是 `0xC0000409`（`Assertion failed ... async.c`）。
根因：Windows 上 `process.exit()` 时还有未关闭的 `uv_async` 句柄（kill 子进程的副作用）。
改法：`process.exitCode = 0` 让事件循环自然排空；`chat-local.mjs` 同修。
★ 这次是**闸拦住了闸自己**——如果没这道闸，这个退出码问题会一直潜伏，直到某次真失败被当成噪声。