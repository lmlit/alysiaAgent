# Change Proposal: retire-glm-vision-bridge

## 元信息

- **日期**: 2026-10-15
- **类型**: MODIFY（图片进入流水线的方式）+ DOC（`vision-bridge` spec §1 前提已失效）
- **状态**: **pending（保持现状；2026-10-26 复确认「先不改」）**：GLM 免费且描述可进记忆，DeepSeek 直通会每轮重发图片
- **影响 spec**: `vision-bridge`（frozen，§1 前提被证伪；§2 配置 / §4 接入点 / §6 限制 连带）
- **发现于**: 用户 2026-10-15「我们 ds 可以支持识别图片了，可以把 glm 识别图片那一层撤销掉」

## 动机（为什么记这一条）

`vision-bridge/spec.md` §1 开篇的第一句前提是：

> **「聊天主模型是纯文本 DeepSeek，无法直接看图。Vision Bridge 为它提供图片理解能力。」**

**这句话在 2026-10-15 实测已经不成立**——DeepSeek 的聊天模型现在原生接受图片输入。

### 实测证据（2026-10-15）

| 测试 | 结果 |
|---|---|
| `GET /v1/models` | 返回 `deepseek-flash`、`deepseek-v4-pro`（`deepseek-v4-flash` 是解析到 `deepseek-flash` 的别名） |
| 1×1 像素 PNG | HTTP 200，`prompt_tokens=223`（纯文本部分约 20） |
| 256×256 蓝底白圆 | HTTP 200，回答「主色蓝，白色圆形居中，无字符」——**正确** |
| 256×256 黄底黑形 | HTTP 200，回答「黄底黑色…」——**正确** |
| 图片 token 开销 | 256×256 小图约 **234 prompt tokens**（手机真实照片会显著更高） |

结论：**视觉能力已在主模型内部，GLM-4V-Flash 那层在技术上冗余。**

## 需求（若要动手，做什么）

- [ ] 决定图片进入流水线的形态（见设计决策的三方案）
- [ ] 若采用，同步修 `vision-bridge/spec.md` §1 —— **其前提已失效，必须改写而不是删除**
- [ ] 对账 `.env`：视觉 key/endpoint 的去向（现复用智谱 `EMBED_API_KEY`）
- [ ] 对账 `sampling.vision.describe` 槽位（`core/provider/sampling.ts`）存废

## 设计决策（关键：这不是"删一层"，是"改路径"）

### 现路径（`vision-bridge` §1）

```
QQ 图 → 适配器下载 → VisionBridge.describe() → GLM-4V-Flash 返回**文字**
      → 描述文本作为普通 MessageEvent 进流水线
      → 事件日志 / 向量库 / 画像提取 —— 全是文本
```

### ★ 核心约束：**记忆系统是纯文本的**

`MessageEvent`、嵌入、召回、画像提取全建立在文本上。所以"把图直接塞给模型"会让：

- **当次对话**：她能看见 ✅
- **记忆**：事件日志里没有图、向量库里没有图 → **她"看过就忘"**，下次提起来完全不记得你发过
- 要保住记忆，就**仍然需要某种文字形式** → 那 GLM 层不是"撤销"，而最多是"替换"

### 三个方案

| 方案 | 做什么 | 改动量 | 她的记忆 | 图片细节 | 成本 |
|---|---|---|---|---|---|
| **A. 只换模型** | 保留「图→文」结构，`bridge.ts` 把 GLM 换成 DeepSeek | **最小**（一处 endpoint/model/key） | ✅ 不变 | 仍有转述损失 | 由免费变**按 token 计费** |
| **B. 图直通模型** | adapter 把图作为 `image_url` content 传给 LLM | **大**：要改 `MessageEvent` 数据模型 + 整条流水线 | ❌ 靠猜 | ✅ 无损 | 同上 |
| **C. 双轨** | 当次直通模型 + 同时存描述进记忆 | 最大 | ✅ | ✅ | 最高（图算两次） |

**成本对账**：GLM-4V-Flash **免费**；DeepSeek 视觉按 token 收，且**每轮对话重发图片**（除非命中 prompt cache）。
Q Q 通道上图片量直接决定这笔账划不划算 —— **不能只看"技术上能"，要看"用起来贵不贵"**。

### 建议的推进顺序（若将来动手）

**先 A，不要直接上 B。** 理由：

1. A 是**一处改动**，记忆系统 / 流水线 / 数据模型全不动
2. 能用**真实照片**对比两个模型的转述质量——若 DeepSeek 转述还不如 GLM，B 就白做了
3. B 要动 `MessageEvent` —— 那是**核心契约**，风险等级与 A 完全不同

## 对账方向确认

- [x] 与现有 spec 冲突？**是，且方向明确为「改 doc」**。
  `vision-bridge` §1 的「主模型无法看图」是**外部事实变了**（DeepSeek 支持视觉），
  属 **impl 仍在工作、doc 前提已失效** → 动手时必须**改写 §1**，而不是把 spec 降级迁就旧实现。
  ★ 在动手之前，本 change 只**记录**，不改任何文件。
- [x] 涉及 Web API？**不涉及**（`docs/Web-API-Design.md` 无图片相关契约）。
- [x] 涉及 core / server 代码？涉及（`core/vision/bridge.ts`、`server/modules/vision.ts`、
  `server/modules/adapters.ts`、`server/adapters/qq-official.ts`、`core/provider/sampling.ts`），
  但**本 change 当前不实现**。

## 测试计划（若将来动手）

- A 方案：用**同一批真实照片**（含文字截图、复杂场景、低光照）做 GLM vs DeepSeek 转述质量的**并排对比**
- 成本实测：记录单图 prompt tokens 与每轮重复计费量，给出「每 100 张图的费用」
- 记忆回归：确认描述文本仍正常进事件日志 / 向量库 / 画像（不因换模型而丢）
- B 方案（若采用）：`MessageEvent` 数据模型变更需独立 change，**不夹带在本 change 里**

## 明确不做（用户 2026-10-15 决定）

- **现在不改任何代码** —— 用户明确「先不改了，记一下吧，知道有这个东西」
- **不删 `VisionBridge`** —— 它仍在正常工作，GLM-4V-Flash 仍然免费且够用
- **不动 `.env` / `config.yml` / `sampling` 槽位** —— 一并留待决策
