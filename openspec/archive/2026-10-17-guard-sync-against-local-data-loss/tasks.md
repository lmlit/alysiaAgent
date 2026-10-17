# Tasks: guard-sync-against-local-data-loss

> 2026-10-17 完成 propose → apply → archive。

## 实现

- [x] `scripts/check-sync-data-loss.cjs`（新，**只读**）
      - 比较 `--local` 与 `--incoming` 的事件/会话 **id 集合**
      - 报出**本机独有**的条数，并按渠道归类（`channel` 列在则用它，否则退回 `session_id` 前缀）
      - 连带显示 `facts` / `character_facts` 计数差异（供人判断，**不阻止**同步）
      - 退出码 `0`/`1`/`2`；中英文都不吓人，但把后果说清楚
- [x] `packages/server/scripts/sync-from-server.sh`：
      - 新增 **[5/7] 数据丢失体检**（位于"校验同步文件完整性"之后、"备份+替换"**之前**）
      - 非 0 即**中止**；`ALYSIA_SYNC_ALLOW_LOCAL_LOSS=1` 时放行并**显式打警告**
      - 首次同步（本机还没有库）跳过体检并说明
      - 步骤编号 `[n/6]` → `[n/7]` 全部顺延一致

## 验证

| 项 | 方法 | 结果 |
|---|---|---|
| 场景① 本机有 dsh、远端没有 | `--local bak-20261015-213807 --incoming 远端快照` | **exit 1**；报出 **884** 条独有事件 `{"dsh":730,"qq":146,"webui":8}` + **32** 条独有会话 ✓ |
| 场景② 本机是远端子集 | `--local alysia.db --incoming 远端快照` | **exit 0** 放行 ✓ |
| 语法 | `bash -n`（Git 自带 bash；本机 `bash` 是没装发行版的 WSL 桩，不可用） | **exit 0** ✓ |
| 接线 | 用脚本里**完全相同**的调用方式跑（cwd=`packages/core`、相对路径 `..\..\scripts\...`） | 正确定位脚本、`better-sqlite3` 解析成功、exit 1 ✓ |

★ 场景①**就是 10-15 那次事故的数据**：本项等于把那次事故重新演一遍并确认**这次会被拦下**。

## 未做（如实）

- **没有测试 `sync-from-server.sh` 的端到端**（那会真的 SSH 导出 + 替换本机库）。
  验证的是：同一段判断逻辑 + 同一套调用方式 + 语法。
- **没做"自动合并"**：刻意不做（D3）—— 工具不该替人决定什么该进生产。
