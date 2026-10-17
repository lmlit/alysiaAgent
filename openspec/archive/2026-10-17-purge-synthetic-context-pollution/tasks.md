# Tasks: purge-synthetic-context-pollution

> **KI-20 的存量数据修复**。代码侧（不再产生新的注入）早已由 `filter-synthetic-context-inflow` 归档；
> 本 change 是**把那 180 条历史污染从数据里清掉，并让 dsh 记忆真正可用**。
>
> 2026-10-16 立项（取证）→ **2026-10-17 执行完毕**（用户点「执行」）。

## ① 先搞清楚"污染在哪"（这一步救了这个计划）

立项时的假设是"污染在服务器上，要清理服务器"。**实测推翻了它**：

| 库 | 事件 | dsh | 注入 |
|---|---|---|---|
| **远端服务器**（权威） | 1828 | **0** | **0** |
| 本机 `alysia.db`（10-15 的远端快照） | 1807 | 0 | 0 |
| 本机备份（停在 10-02） | 1689 | **730** | **180** |

原因：`ALYSIA_HOST` 是**回环地址** ⇒ dsh 回传打的是**本机**，不是服务器。

⚠️ 若照原假设直接"清服务器"，会**清不到任何东西**；而若顺手把本机备份合并进去再传回去，
则会**把 180 条注入和 730 条 dsh 事件一起塞进生产**——方向完全反了。

## ② 三个我**不擅自决定**而先问的点

1. **是否要让生产也记得 dsh**（产品决策）→ 用户选 B（要，因为后续要从 QQ 侧调用 dsh 编程工具）
2. **合并的语义** → 只**追加事件/会话**，`facts`/`character_facts`/`persona`/`hints` **保留远端原样**
   （远端更新；整库替换会丢掉 33 条角色事实并让人格回退）
3. **存量 `channel` 回填** → 放进本次离线工具（见 `add-memory-channel-field` 的 R9）

## ③ 工具（全部 `--in/--out`、默认 dry-run、绝不原地改）

- `scripts/ki20/purge.cjs` 清注入事件 + 派生 facts（**输入全程只读**，哈希前后对比证明）
- `scripts/ki20/merge.cjs` 以远端为基准只追加 dsh 记忆（含 channel 迁移 + 存量回填）
- `scripts/ki20/embed-backfill.cjs` 向量补嵌（幂等、只 add）
- `scripts/ki20/checkpoint.cjs` WAL 合并（搬运前保证 `.db` 自包含）

## ④ 执行记录（2026-10-17）

| 步骤 | 动作 | 结果 |
|---|---|---|
| 备份 | 服务器 `VACUUM INTO` 导出 DB + **570M** 向量库 tar；本地异地再存一份 | ✓ |
| 清理 | 180 条注入事件 + 1 条派生 fact | 源库哈希未变 ✓ |
| 合并 | qq 1828 + **dsh 550** = **2378** 事件；+5 条 dsh 会话 | integrity ok |
| 替换 | 停容器 → 预替换备份 → 换库 → **清 4.1MB 的 WAL/SHM** → 起容器 | healthy |
| 补嵌 | **555 条**（550 事件 + 5 摘要）→ 向量表 2646 → **3201** | 缺向量 0 |
| 校验 | 残留注入 0 / integrity ok / 容器 healthy / 重跑 dry-run 0 缺失（幂等） | ✓ |
| **召回抽查** | dsh 向查询命中 dsh 事件（"抓到了，而且证据是决定性的"等）；qq 向查询命中全 qq | ✓ **两侧互不干扰** |

**保留的现状**：`facts`/`character_facts`/`persona`/`hints` 是远端的（未用旧状态覆盖）；
`hints` 里落在注入窗口的 78 条**按先例保留**（内容是真实的用户偏好回放，只是入口脏）。

**未带回的**：追加源里 154 条只存在于本机的旧 QQ/webui 事件（原因不明，不擅自塞回生产）；
dsh 时代的 48 条 facts（34 条 active）—— 用户明确「不用了」。

## ⑤ 回滚

```
cp /root/alysia/backups/alysia-db-preswap-*.db /root/alysia/data/alysia.db
rm -f /root/alysia/data/alysia.db-wal /root/alysia/data/alysia.db-shm
tar xf /root/alysia/backups/lancedb-20261017-080529.tar -C /root/alysia/data/workspace
docker restart alysia-server
```

## ★ 执行中自己踩的坑（留档）

**LanceDB 的 JS `query()` 默认只返回 10 行**——我错了两次：
① 把它当成"现有向量只有 10 行"（570M 的库读成 10 行）；若未察觉就 `--apply`，
   会**插入 555 条重复向量**（本脚本只 add 不 delete）。**是在 apply 前先探 `countRows()`（2646）才发现的。**
② 修了初始枚举后，**结尾校验又踩同一个坑**，导致 555 条全部插入成功却被误报"仍未补上"。
⇒ 现在抽成 `listIds()` 一处定义两处使用，并加护栏：**id 列表长度 ≠ `countRows()` 就拒绝执行**。

另：ssh here-string 里带引号/花括号的命令被打坏两次，导致容器多停了一次（DB 当时未被改动）。
用户明确「服务器只有我一个客户，不需要保护服务全程可用」。
