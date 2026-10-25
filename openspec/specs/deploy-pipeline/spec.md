# deploy-pipeline — 部署流水线（本地构建 → 上传 → 服务器切换 → 健康门 → 回滚点保留）

> 建立于 2026-10-25（change: `prune-old-rollback-images`）。
> 实现：`scripts/deploy.mjs`（编排）+ `scripts/lib/rollback-retention.mjs`（保留决策，纯函数）。
> 配套 SOP：`docs/Docker-Deployment.md`（手工步骤与排错表）；本 spec 记**契约**，SOP 记**操作**。

## 1. 定位与边界

**一次部署 = 在本地把"能跑的真东西"验完，再用可回退、可验收的方式换上去。**

| 部分 | 负责 | 不负责 |
|---|---|---|
| `scripts/deploy.mjs` | 前置检查、本地 smoke、全量测试、config 漂移闸、构建、上传、切换、健康门、自动回滚、回滚点回收 | 不做业务判断；不改服务器上的 `data/` |
| `scripts/lib/rollback-retention.mjs` | 回滚点保留/删除的**纯决策**与**远程脚本生成** | 不碰 ssh/docker（由调用方执行） |
| 服务器 | 存镜像、跑容器 | 不构建（镜像由本地 build 后 `docker save` 上传） |

**非目标**：多环境（staging）；蓝绿/金丝雀；CI 远端构建。

## 2. 流水线顺序（契约 1–3）

实际打印的 Step 顺序（`deploy.mjs` 的 `log()` 文案）：

```
Step 0  前置检查          HOST/config.yml/工作区干净/docker info/ssh 免密
Step 0c 本地真机 smoke    起真服务 + 调真 API（不可跳过，见契约 2）
Step 0b 全量测试          vitest（只看退出码）
Step 1  config 漂移闸     git diff 服务器 vs 本地 config.yml（见契约 3）
Step 1b 回滚点盘点        只读：打印将保留/将删
Step 2  前端产物          pnpm build:console（镜像只 COPY console/out）
Step 3  构建镜像          docker compose build
Step 4  打包 + 上传       docker save → scp
Step 5  部署              打回滚标签 → load → 切 compose → 健康轮询 → 失败自动回滚
Step 6  回收旧回滚点       只保留最近 N 个（见 §3）
```

- **契约 1：顺序不可换 —— 本地真机 → 生产。** `--skip-smoke` 是唯一例外，
  用了会**大声警告**（只该用于"生产已烧起来、必须紧急回滚"）。
- **契约 2：不看文本判成败，只看退出码。** 2026-10-25 踩过：smoke/测试的 stderr 里塞满
  测试自己的日志，按文本匹配会把"其实全绿"判成失败 ⇒ 部署被自己拦下。
- **契约 3：config 漂移默认拒绝。** `config.yml` 是 gitignore 的、两端各自漂移；整份覆盖会
  **静默抹掉**服务器独有键（实测把 `max_tokens 1024→256`、`4096→2048` 与整段 `projects:`
  退回默认 ⇒ 委托工具不注册）。要显式 `--merge-config` 才继续。

## 3. 回滚点保留策略（契约 4–9）

起因：Step 5 只打 `rollback-*` 标签、从不删除。2026-10-25 实测生产 **37 个镜像 / 8.736 GB，
可用只剩 1 个**，当天 12 次部署 = 12 个回滚点（约 4.7 GB/天），`/` 用掉 23G/40G。

- **契约 4：部署成功后只保留最近 N 个回滚点，默认 N = 3。**
  配置面：`--keep-rollbacks=N` > `ALYSIA_ROLLBACK_KEEP` > 默认 3。
- **契约 5：`latest` 结构性不可删。** 待删集合由**正则白名单** `ROLLBACK_TAG_RE`
  （`^server-alysia:rollback-[A-Za-z0-9][A-Za-z0-9._-]*$`）产出，`server-alysia:latest`
  不可能匹配 ⇒ 不依赖"记得跳过"。
- **契约 6：排序看 docker 的 `CreatedAt`，不看标签名。** 生产上存在
  `rollback-20261017`（无时分秒）、`rollback-20261021-preimage`（非时间后缀）；
  按名字排会把最老的当最新的留下 —— 且**不报错**，只会在真要回滚时才发现退了三周。
  同一 `CreatedAt`（一个镜像多个标签，生产真出现过）时以标签名兜底，保证**确定性**。
- **契约 7：非法 N 退回默认，负数不钳到 0。** `-1` 是手滑，不是"只留 latest"的意图；
  `0` 只能显式传。
- **契约 8：悬空镜像清理带 label 过滤。**
  `docker image prune -f --filter label=com.docker.compose.project=server`
  —— 只清我们自己 compose 构建的 `<none>`。filter 不被支持时输出 `dangling=skipped`
  **宁可不删**，绝不退化成 `prune -f`。
- **契约 9：失败必留现场。** 清理只在 Step 6（健康通过之后）执行；`FAIL=load/up/health`
  与自动回滚分支在 Step 5 内 `exit` ⇒ 控制流保证现场不会被删。

## 4. 验收口径（契约 10–11）

- **契约 10：清理后必须回报四项**，缺一不可：
  `removed=N` / `dangling=pruned|skipped` / `health=<code>` / `latest=present`，
  外加 `disk=已用/总量 (百分比)` 与 `container=名字|状态`。
- **契约 11：`latest` 缺失 ⇒ 非 0 退出**（此时部署本身已成功，但环境已坏，必须人来看）；
  `health≠200` ⇒ 只告警（不因清理把已成功的部署判成失败）。

## 5. `--dry-run` 语义（契约 12）

- **契约 12：`--dry-run` 只读。** 跑完 Step 0–1 + 1b 盘点后 `exit 0`：
  打印"保留哪些 / 将删哪些"，**不打回滚标签、不 load、不删、不 prune**。
  （Step 0c smoke 与 Step 0b 测试在 dry-run 里**照跑** —— 它们的价值就是提前暴露"本地就不过"。）

## 6. 实测记录（2026-10-25）

**手工基线清理**（脚本化之前）：

```
清理前  Images 37 / 8.736GB / 可回收 97%     / 40G 用 23G (62%)
清理后  Images  4 / 1.115GB                  / 40G 用 15G (41%)
        docker image prune 回收 2.203GB（悬空 9 个）
        保留 latest + rollback-20261025-182610 / -180808 / -175252
        docker ps = Up (healthy) · /api/health = {"status":"ok"}
```

**脚本路径真机 e2e**（给最旧回滚镜像额外打假标签 `rollback-19700101-e2e`）：

```
keep  : rollback-20261025-182610, -180808, -175252
remove: server-alysia:rollback-19700101-e2e
removed=1 / dangling=pruned / image-count=4 / health=200 / latest=present
```

**单测**：`packages/server/tests/deploy-rollback-retention.test.ts` 19 条全绿
（含"latest 永不在待删集合""CreatedAt 优先于标签名""注入标签被过滤""非法 N 退回默认"）。

## 7. 已知边界与后续

1. **回滚点没有时间维度的过期**：只按"最近 N 个"保留。若某天部署都在同一小时内，
   N=3 可能只覆盖几十分钟的历史 —— 那时应临时 `--keep-rollbacks=5`，而不是改默认值。
2. **`docker save` 的 tar 包不进清理范围**：`packages/server/alysia-image.tar`（125 MB）每次
   部署重写，仓库里还有 `.tools/staging/*.tar.gz` 旧包（未被 git 跟踪）。属"本机杂物"，
   见 change 的 tasks「环境清理」第 3 项，待拍板。
3. **本机构建缓存不在本流程内**：`docker builder prune` 需手工（2026-10-25 本机回收 21.24 GB）。
   若以后频繁构建，可考虑在 Step 3 后按大小阈值清理。
4. **`config.yml` 漂移闸依赖 `git diff --no-index`**：服务器侧若换行符/编码变化会产生噪声 diff，
   此时按"服务器独有行"逐行判断，不整份覆盖 —— 这是有意的保守。
