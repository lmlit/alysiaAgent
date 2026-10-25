# Change Proposal: finish-her-records

## 元信息

- **日期**: 2026-10-25
- **类型**: MODIFY（补齐上一个 change 的两块未完成）
- **状态**: applied
- **影响 spec**: `ai-life-system`（回读范围 + 只读出口）
- **前置**: `her-records-one-table`（已归档：表合并 + 私密日记 + 生活生成回读）

## 为什么还要补

上一个 change 落地后，我在 tasks 里**明确标了两块没做**（没有宣称做完）：

1. **反思回读**：`buildPrivateDiaryBlock` 只接进了"生活事件生成"，反思还没接
2. **Web 只读出口**：私密日记只有库里有，没有界面/接口

而这两块正是「两本日记」的完整闭环：
- 不接反思 ⇒ 她复盘时**读不到自己前几天的私密本**，等于每天从零开始认自己
- 没有出口 ⇒ **你**看不到她在没人的时候写了什么（而这正是"给她自己那本"的另一半价值）

## 需求

- [x] `maybeDailyReflection` 的 context 加 `【你最近写下的】`（最近 3 篇私密记录，每篇 ≤80 字）
- [x] `GET /api/life/her-records?kind=diary|reflection&visibility=shared|private&limit=30`（只读）
- [x] `GET /api/life/private-diaries`（便捷别名：只看私密日记）
- [x] smoke 网关加两个断言：两个端点都 200、`records` 是数组
      （新库为空也正常 —— 断言的是"接口在"，不是"有数据"）

## 边界（写进契约）

`visibility=private` 的内容**不进聊天链路 / 不进推送 / 不进博客**。
这个端点只是「**你能看**」，不是「它可以被引用」。两者混同，私密本立刻变成表演。

## 测试

- `life-service.test.ts` +1 例：★ 私密日记进**反思** context
  （用 `listHerRecords` mock + 捕获 `generateReflection` 收到的 ctx）
- smoke：`/api/life/her-records` 与 `/api/life/private-diaries` 均 200 且结构正确
- 全量：**169 文件 / 1975 用例**

## 本地真机验证

```
▸ 调真 API：GET /api/life/her-records
  ✓ records=0 条（空也正常：新库还没有日记）
  ✓ /api/life/private-diaries 可用
▸ 本地真机对话：她照常回话（「在窗边坐了一会儿呀…人家还想是不是自己看错了呢♪ 你在忙吗？」）
```

## 风险

- 低。只加只读端点与一段 context；`her-records` 默认 `limit=30`，上限 200。
