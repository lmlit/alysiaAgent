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
- [ ] `pnpm deploy`（smoke 闸会先跑）
- [ ] 部署后验：`GET /api/life/her-records?visibility=private` 能拿到生产那 1 条反思私密记录
- [ ] 归档

## 明确不做
- ❌ console 页面（先给接口；界面等真要看的时候再做）
- ❌ 把私密内容注入聊天（那是表演，契约里写死了）