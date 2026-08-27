# Change Proposal: worldbook-digest-summary

## 元信息

- **日期**: 2026-08-27
- **类型**: MODIFY（改现有行为）
- **状态**: archived
- **影响 spec**: `ai-life-system`

## 动机（为什么做）

世界书 text 设定条目普遍超 200 字（实测：66 条中位 425 字、最长 1003 字），8-27 分层随机的 200 字截断会把角色关系细节硬切掉（白厄 974 字截到 200 基本只剩标题）。不截断又让世界观 lore 稀释注意力。

**方案**：一次性成本换长期质量——LLM 为每条 text 条目生成 120-150 字「角色简介」（核心设定 + 与昔涟的关系 + 对生活的意义），事件生成注入用简介而非截断正文。成本：66 条 × 一次调用 ≈ 几分钱，之后每次生成都受益。

## 需求（做什么）

- [ ] `worldbook_entries` 加 `digest` 列（ALTER + try-catch，不 DROP）
- [ ] `getWorldbookSample` 优先返回 digest；无 digest 的条目回落截断 200（新导入条目兜底）
- [ ] 一次性生成脚本 `scripts/digest-worldbook.ts`：批量调 LLM 生成简介，幂等（只处理无 digest 的条目），失败条目跳过可重跑
- [ ] 简介要求：① 提炼核心设定不照抄 ② 点明对昔涟日常生活/性格/关系的影响 ③ 涉及角色写明与昔涟的关系 ④ 语言自然（角色背景卡风格）

## 设计决策（怎么做，含备选与取舍）

| 决策点 | 结论 | 备选（否决理由） |
|--------|------|------------------|
| digest 存储 | worldbook_entries.digest 列（读采样时零成本） | 单独 digest 表（多一次 join，无收益） |
| 生成时机 | 一次性脚本（可控可审计，失败可重跑） | 启动时自动生成（66 条 × LLM 拖慢启动、不可控） |
| 注入优先级 | digest 存在用 digest；缺失回落截断 200 | 全量要求 digest（新条目导入会漏，需兜底） |
| life_event/image | 不生成 digest（life_event 天然 ≤154 字；image 是表情包） | — |
| 截断长度 | text 截断阈值保持 200（有 digest 后基本不再命中） | 调大 400（旧无 digest 条目仍会被硬切，简介才是治本） |

## 对账方向确认

- [x] 与现有 spec 不冲突——8-27 分层随机的"截断 200 字"升级为"digest 优先 + 截断兜底"
- [x] 涉及 Web API？getWorldbookSample 返回结构不变（{id, content}——content 字段在 digest 存在时返回 digest），对照 `docs/Web-API-Design.md` 后确认无需改契约

## 测试计划

- 单元：getWorldbookSample 优先 digest / 缺失回落截断 / digest 为空串处理
- 脚本冒烟：真实跑一次生成（mock 或真实 LLM），验证 66 条全部有 digest
- 回归：`npx vitest run` 全绿
