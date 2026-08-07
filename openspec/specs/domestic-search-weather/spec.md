---
status: frozen
source: docs/superpowers/specs/2026-08-02-domestic-search-weather.md
migrated: 2026-08-07
---
# 搜索/天气国内适配 — 设计文档

> 日期: 2026-08-02
> 状态: 已实现
> 前置: 无

---

## 1. 背景

原实现用 DuckDuckGo / Wikipedia / wttr.in——**国内被墙**（curl 实测全部返回 000，连接被 RST）。需替换为国内可达的数据源，同时保留回退链。

---

## 2. 数据源实测

| 数据源 | 实测结果 | 用途 |
|--------|----------|------|
| cn.bing.com | ✅ 200 | 网页搜索（HTML 解析） |
| api.bing.com / www.bing.com | ✅ | 同域 |
| weather.com.cn | ✅ | 实时天气 |
| DuckDuckGo / Wikipedia / wttr.in | ❌ 000（被墙） | 仅作回退 |

---

## 3. 设计（core/tools/web-search.ts）

### 3.1 搜索

```
search(query)
  → cn.bing.com HTML 抓取（带 Referer/UA）
    → b_algo 正则解析（<li class="b_algo"> 块，提取标题 + url + 摘要）
    → 结构化结果列表
  → 失败回退: DuckDuckGo html → Wikipedia opensearch API
```

- 返回格式：`[1] 标题 - 摘要\n链接: URL`（LLM 可直接消费）
- 关键正则：`/class="b_algo"/` 分割条目，逐条提取 `<h2>` 标题、`<cite>` 链接、`<p>` 摘要

### 3.2 天气（国内城市）

```
weather(city)
  → 城市名 → 城市代码表（约 45 个城市，硬编码 code 映射）
  → GET http://www.weather.com.cn/data/cityinfo/{code}.html
    → { weatherinfo: { city, temp1, temp2, weather, wind, ... } }
  → 格式化: "北京 晴 15℃~25℃ 东南风3级"
```

- 城市代码表：`CITY_CODES: Record<string, string>`（如 北京→101010100）
- 未知城市 → 返回提示 + 支持的城市列表（截断）
- 接口返回 GBK/UTF-8 兼容处理（fetch + text()）

### 3.3 回退链设计

```
search: cn.bing → DuckDuckGo → Wikipedia → 明确报错
weather: 城市代码命中 → 实时接口；未命中 → 报错提示（不再走国外源）
```

---

## 4. 工具定义

- `web_search`：查询任意信息（参数 query）
- `get_weather`：查询城市天气（参数 city）

两者均为 LLM 可调用工具，结果直接进 Agent 上下文。

---

## 5. 已知限制（待办）

- [ ] 城市代码表仅 45 个主要城市，小城市不支持
- [ ] cn.bing HTML 结构变更会破坏解析（正则脆弱）——需定期验证
- [ ] 无请求限速（高频调用可能被 bing 风控）
