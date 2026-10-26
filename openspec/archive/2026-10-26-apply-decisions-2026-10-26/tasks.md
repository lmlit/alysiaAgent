# Tasks: apply-decisions-2026-10-26

## 1. 预算进默认值
- [x] `sampling.ts`：personalize 256→1024、session.summary 2048→4096（带证据注释）
- [x] `config.example.yml` 同步两处默认值与说明
- [x] `sampling.test.ts` 精确断言改 4096

## 2. 历史画像只读盘点
- [x] 新增 `scripts/audit-historical-profile.cjs`（readonly + `--db` + `--json`）
- [x] 本机库自测：facts 84 / basics 0 字 / 从未结算 session 2（**未写入**）
- [ ] 生产库盘点（需 host；本会话没有）

## 3. pipelineMode 标死
- [x] `CLAUDE.md` 的 `pipelineMode` 说明改为“仅 API/测试可达，生产无写者”
- [x] `PLAN §2.7` 记录处置：标死、保留 `assembleCode`

## 4. P4 删空变量
- [x] `dsh-adapter/src/index.ts` 删除 `alysia_life` 注册与未用 import
- [x] `dsh-adapter/tests/index.test.ts` 改为断言**不再注册**
- [x] `dsh-adapter` spec 注明变量已移除

## 5. P5 写清设计意图
- [x] `ai-life-system` spec 注明生活事件 context 刻意不含用户画像

## 6. KI-27 删一半
- [x] `types.ts` 删除 `MemoryEvent.processed` 与 `PROCESSED_*`
- [x] `database.ts` 新库不再建列/索引（旧库列保留、无人读写）
- [x] `EventStore` 删除 `getUnprocessed` / `markProcessed`
- [x] `RealtimeProcessor` / `SessionEndProcessor` 停止写位
- [x] `CronProcessor` 删除 compaction 与 `eventStore` 参数
- [x] 三处事件构造（pipeline / server ingest/proactive/life）去掉 `processed: 0`
- [x] 受影响测试改为断言真实状态（事件仍在 / facts_status / worldbook 命中）
- [x] `KNOWN-ISSUES` KI-27 标记已完成

## 7. console a11y
- [x] `packages/console/app/globals.css`：`prefers-reduced-motion` 下关 4 个 token + 全局降动画
- [x] `pnpm build`（console）通过（Next 静态导出 10 页）

## 8. 看门狗
- [x] `self-notice.ts` 增加“正挡着活就说一声”
- [x] `self-notice.test.ts` 断言新句

## 9. 暂缓项记录
- [x] `build-alysia-console-plugin` 标冻结
- [x] `add-approval-gate` / `improve-sticker-selection` / `retire-glm-vision-bridge` / `add-ops-health-report` 标暂缓
- [x] `docs/TODO.md` 同步（含本机杂物已删、KI-27 销账）

## 10. 杂物
- [x] 删除 `packages/server/alysia-image.tar` 等 4 个文件（498.2MB）

## 验证与归档
- [x] 全量测试 Node 24：**170 文件 / 1985 用例全绿**
- [x] 归档到 `openspec/archive/2026-10-26-apply-decisions-2026-10-26/`
- [x] 提交 + 推送到 origin/master（`a107297`）
