# Change Proposal: apply-decisions-2026-10-26

## 元信息

- **日期**: 2026-10-26
- **类型**: 混合（FIX / DOC / TOOL）—— 用户一次拍板的“默认建议包”
- **状态**: applied（待归档）
- **来源**: 用户对 `docs/TODO.md` 待拍板清单逐条选择“按建议”
- **影响 spec**: `memory-system`（预算 / 位掩码）、`dsh-adapter`（P4 变量）、`alysia-console`（a11y）、`ai-life-system`（P5 设计意图）

## 决定与依据（逐条）

| # | 决定 | 做什么 | 依据 |
|---|---|---|---|
| 1 | 预算进默认值 | `proactive.personalize` 256→**1024**；`session.summary` 2048→**4096**；`config.example.yml` 同步 | 生产 10-16 实测：256 被 reasoning 吃满 ⇒ 空问候；2048 被 reasoning 占 1912–1973 ⇒ JSON 截断。仓库默认若不改，新部署会再犯 |
| 2 | 历史画像只读盘点 | 新增 `scripts/audit-historical-profile.cjs`（readonly，统计空洞/失败窗口）；**不重放** | 全量重放 `onSessionEnd` 会触发人格确认与画像改写，成本/副作用未评估。先看清规模再选 D 案（只补 failed 窗口） |
| 3 | `pipelineMode` 标死 | 文档改为“生产无写者，仅单测 / `POST /api/memory/read {mode:'code'}` 可达”，保留 `assembleCode` | 服务端 `codeMode=false`、dsh 不走它；删会破坏已登记的 API 用法 |
| 4 | P4 删空变量 | dsh-adapter 删除 `{{alysia_life}}` 注册（恒 `undefined`，仓内无模板引用） | “声称存在却永远为空”的入口会误导下一个人；生活注入已随 `alysia:memory` |
| 5 | P5 写清意图 | 在 `ai-life-system` 注明：生活事件 context **刻意不含**用户画像（独立人格） | 8-29 注释即设计意图；不写清会被下次当 bug 修 |
| 6 | KI-27 删一半 | 删除 `PROCESSED_*` / `getUnprocessed` / `markProcessed` / compaction；旧库列保留但不再读写 | 位掩码只写不读；真实状态在 `summary_status` / `facts_status`。用户选 B（不赋语义） |
| 7 | console a11y | 17 处持续动画加 `prefers-reduced-motion` 守卫 | 无障碍；只改动画 token 与 animation 时长，不动布局 |
| 8 | 看门狗加一句 | `[你刚注意到的事]` 末尾加“正挡着活就说一声” | 用户原话「碍着你手上的活就说一句」；说不说仍由她决定 |
| 9 | 暂缓项记录 | 控制台插件冻结、审批闸/表情包/GLM/日报记为暂缓 | 用户 2026-10-26 拍板 |
| 10 | 删本机杂物 | 删除 3 个部署中间产物 + staging 两份 tar（~498MB） | 未跟踪、可重建 |

## 明确不做

- **不部署**：本会话没有 `ALYSIA_DEPLOY_HOST`；预算与 KI-5 等运行时改动等下一次正常发版。
- **不做历史重放**（只盘点）。
- **不动主题**（用户 2026-10-26 明确）。

## 对账方向

- 预算：**impl 改回生产已验证值**（不是降级迁就文档），并把证据写进 spec。
- KI-27：**删实现**，spec 同步删掉“位掩码”契约，保留“不要第二套状态”的教训。
- P4：**删实现**，spec 说明变量已移除（不是标 reserved）。
- P5：**改 doc**（impl 与设计意图一致）。

## 测试

- 全量 Node 24（数字见 tasks.md）。
- 预算：`sampling.test.ts` 精确断言 4096。
- KI-27：受影响用例改为断言真实状态/事件存在，不再断言位掩码。
- P4：dsh-adapter 用例改为断言**不再注册** `alysia_life`。
- a11y：console build 通过（CSS 无单测）。
- 看门狗：`self-notice.test.ts` 断言新增句。
