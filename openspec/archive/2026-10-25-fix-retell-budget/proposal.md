# Change Proposal: fix-retell-budget

## 元信息

- **日期**: 2026-10-25
- **类型**: FIX（预算不足导致偶发空响应）
- **状态**: **archived**（2026-10-25 已部署：512 复现 2/3 空，2048 为 2/2 成）
- **影响 spec**: `ai-life-system`（两段式契约里那句"必须带 max_tokens"补上实测值）
- **来源**: 上线后实盘验证 —— 同一条输入，第一次给出 25 字、第二次**空**

## 动机：512 是我估的，不是测的

`life.retell` 首版 `max_tokens: 512`，理由是"输出只有一两句话"。上线后做 5 连测：

```
max_tokens  finish   in    out  reasoning  字数   内容
512         stop     416   243  223        27    出门前我在小凳上坐了会儿，膝盖有点软，你那儿也这样吗？
512         stop     416   333  310        29    出门前我把布袋换了个肩，绳结勒得有点紧…
512         stop     416   466  443        30    出门前我在门边小凳上坐了坐…
```

**reasoning 吃掉 223–443 tokens，output 已到 466** —— 再往上就顶 512 ⇒
`finish=length` + content 0 字。这就是 KI-1 的同一形态（会话摘要曾因它 **22 天 100% 失败**，
每日反思 7 天 11 次 empty，画像提取 6 个月只进不出）。

表现是最难查的那种：**同一条输入时好时坏**。

## 需求

- [x] `life.retell.max_tokens` 512 → **2048**（改后 5/5 稳定：output 320–355 / reasoning 299–334）
- [x] 加守卫测试 `retell-sampling.test.ts`：槽位**必须显式有 `max_tokens`** 且 **≥1024**

## 设计决策

**为什么是 2048 而不是"够用就行"的 1024**：实测 reasoning 峰值 443 + 正文 ~30，
1024 只剩一半余量；2048 与本仓其它 JSON 槽（`session.summary` / `profile.extract`）同量级。
预算是**上限**不是消耗，多给不花钱。

**为什么不在 prompt 里让它"少推理"**：推理量是模型行为，写 prompt 抑制它等于让输出质量打折。

## 测试

- `retell-sampling.test.ts` 3 例（有 max_tokens / ≥1024 / 温度区间）
- 全量 **165 文件 / 1941 用例**

## 风险

- 低。只改默认值，可被 `config.yml` 的 `sampling.life.retell` 覆盖。
