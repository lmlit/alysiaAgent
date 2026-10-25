# Change Proposal: prune-old-rollback-images

## 元信息

- **日期**: 2026-10-25
- **类型**: NEW（部署流水线新增「回滚点保留策略」；顺带把既有 Step 顺序追认为 spec）
- **状态**: **archived**（2026-10-25 归档：代码 + 19 条单测 + 真机 e2e + `--dry-run` 均通过；
  spec 已合并进新建的 `openspec/specs/deploy-pipeline/spec.md`）
- **影响 spec**: `deploy-pipeline`（**新建 slug** —— 部署流水线此前只有 SOP 文档 `docs/Docker-Deployment.md`，没有 spec）
- **起因**: 用户提问「我们构建的一些镜像是不是可以删掉了」

## 动机

`scripts/deploy.mjs` 的 Step 5 会在切镜像前把当前镜像打成回滚标签
（`server-alysia:rollback-<时间戳>`），**但从来没有删除逻辑**。2026-10-25 实测生产：

| 指标 | 数值 |
|---|---|
| 镜像数 / 占用 | **37 个 / 8.736 GB**（`docker system df`：可回收 8.511 GB = 97%） |
| 真正在用的镜像 | **1 个**（`server-alysia:latest`，容器 `alysia-server`） |
| 当天产生的回滚点 | **12 个**（01:04 → 18:26，一天内 12 次部署） |
| 历史回滚点 | 6 个（10-15～10-18，含 `rollback-20261017`、`rollback-20261021-preimage` 这类非标准后缀） |
| 悬空 `<none>` | 9 个 |
| 磁盘 `/` | 40G 用了 **23G（62%）** |

一天 12 个 × 一个 390～407 MB ⇒ **约 4.7 GB/天**。

这不是"手滑忘了清"，是**结构性缺陷**：越守规矩（勤部署、每次先打回滚标签）漏得越快。
而它爆掉时不会报"镜像太多"，报的是**数据库写入失败 / 服务 OOM** —— 与部署毫无字面关系，
属于本仓反复踩的那类「不报错的静默失败」（见 `docs/SILENT-FAILURE.md`）。

**同批发现（不在本 change 代码范围内）**：本机 Docker Desktop 构建缓存 21.24 GB
（可回收 17.92 GB，888 条记录、多为两个月前），与本项一并清理（见 tasks 的"环境清理"）。

## 需求（做什么）

- [x] 部署**成功后**只保留最近 N 个回滚点，默认 **3**；`--keep-rollbacks=N` / `ALYSIA_ROLLBACK_KEEP` 可配
- [x] 决策做成**纯函数**（`scripts/lib/rollback-retention.mjs`）并配单测，不写在 bash 里
- [x] `latest` **结构性**不可能进入待删集合（正则白名单，而非"记得跳过"）
- [x] 排序用 docker 的 `CreatedAt` 而不是标签名（生产上有 `rollback-20261017` 这种无时分秒的名字）
- [x] 悬空镜像清理带 compose project 的 label 过滤（共用宿主机上不误删别人的 `<none>`），不支持就跳过
- [x] `--dry-run` 只读盘点（打印将保留/将删），不打标签、不删除
- [x] 部署失败 / 自动回滚分支**不清理**（现场要留着）
- [x] 清理后回报 `latest=present` / `health=` / 磁盘；`latest` 缺失 ⇒ 非 0 退出
- [x] 更新 SOP 文档与 `CLAUDE.md` 的部署小节

## 设计决策（含备选与取舍）

1. **位置：Step 6（健康通过之后）而不是 Step 5 内部**
   失败分支（`FAIL=load/up/health`、自动回滚）在 Step 5 里就 `exit`，走不到 Step 6
   ⇒ 「失败必留现场」是**控制流保证**的，不靠 if 判断。

2. **排序用 `CreatedAt`，不用标签名**
   生产真实标签：`rollback-20261025-182610`（标准）、`rollback-20261017`（无时分秒）、
   `rollback-20261021-preimage`（非时间后缀）。按名字排序会把"最老"当"最新"留下 ——
   而这类错**不会报错**，只会让你在某天回滚时发现退到了三周前的版本。

3. **同一 `CreatedAt`（一个镜像打两个标签）时用标签名兜底**
   生产上真出现过（`010544`/`010556` 同一 ID）。兜底保证**确定性**：
   同样的输入必须给同样的结果，否则"重复部署越删越多"这类问题没法复现。

4. **负数 keep 退回默认（3），而不是钳到 0**
   `-1` 是手滑，不是「只留 latest」的意图；钳到 0 等于一次手滑删光全部回滚点。
   `0` 只能**显式**传。

5. **悬空清理用 label 过滤，不支持则宁可不删**
   `docker image prune --filter label=com.docker.compose.project=server` —— compose 给每个镜像
   都打了 project 标签，所以只清我们自己的 `<none>`。若宿主机不支持该 filter，脚本回
   `dangling=skipped` 而不是退化成 `prune -f`（后者会连别人的镜像一起清）。

6. **否决的备选**
   - *"全部保留、需要时换大盘"*：不解决"一天 12 个"的结构问题，只是把爆炸推后。
   - *"按时间过期（7 天）"*：docker 没有按时间过滤标签的能力，自己算 CreatedAt 与
     "保留最近 N 个"在效果上等价，但解释成本更高（且 7 天内 12 个/天 = 84 个，仍然很多）。
   - *"写进 shell 的 `for` 循环"*：不可单测。真踩过（ki-1 类）—— 判断逻辑一旦只活在远程
     bash 里，就只能靠"看着对"。

## 对账方向确认

- [x] 与现有 spec 冲突？**无既有 spec**。部署流水线此前只有 SOP 文档 `docs/Docker-Deployment.md`。
      ⇒ 本 change **新建** slug `deploy-pipeline`：把现有 Step 顺序**追认为契约**（ratify drift，
      即"实现对、doc/spec 缺"的方向），再叠加新的保留策略契约。
- [x] 涉及 Web API？**不涉及**（只改仓库内运维脚本，不动 core 方法 / 路由）。

## 测试计划

1. **单测**（19 条，`packages/server/tests/deploy-rollback-retention.test.ts`）：latest 永不待删、
   CreatedAt 排序优于标签名、非法 keep 退回默认、注入标签被过滤、脚本带验收输出。
2. **真机 e2e**（`.tmp/verify-prune.mjs`，一次性、不进仓库）：在生产给**最旧**的回滚镜像额外打
   一个假标签 `server-alysia:rollback-19700101-e2e`，跑同一套 parse → plan → buildPruneScript →
   ssh 执行；断言**只删假标签**、三个真实回滚点与 `latest` 原样、健康 200。
3. **`--dry-run` 只读盘点**在改动前后的行为（只打印，不 tag 不删）。

## 实测结果（2026-10-25）

**生产**（手工一次性清理，脚本化前的基线）：

```
清理前：Images 37 / 8.736GB / 可回收 97%；/ 40G 用 23G
清理后：Images  4 / 1.115GB；                  / 40G 用 15G（41%）
docker image prune 回收 2.203GB（悬空 9 个）
保留：latest + rollback-20261025-182610 / -180808 / -175252
```

健康：`{"status":"ok"}`、容器 `Up (healthy)`。

**真机 e2e**（脚本路径，非手工）：

```
keep  : rollback-20261025-182610, -180808, -175252
remove: server-alysia:rollback-19700101-e2e
removed=1 / dangling=pruned / image-count=4 / health=200 / latest=present
✓ 只删了过期的那个，latest 与真实回滚点全在
```
