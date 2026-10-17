# 真机验收记录：isolate-delegated-task-memory（2026-10-17）

> 前置：**服务端已部署**（本次改动含服务端代码，不部署则标记会被静默忽略）。
> 环境：生产 `alysia-server`（北京 `<server>`；**地址不入库**，见 `docs/Docker-Deployment.md`）+ 委托 profile `alysia`。

## 1. 部署记录（只换镜像）

| 项 | 值 |
|---|---|
| 新镜像 | `server-alysia:latest`（本地构建 → `docker save` → 上传 125.4 MB → 服务器 `docker load`） |
| **回滚锚点** | `server-alysia:rollback-20261017`（= 部署前的 latest） |
| 部署方式 | **只换镜像**，`docker compose down && up -d`；**未上传 config.yml / compose.yml** |
| 容器 | `Up (healthy)`；`127.0.0.1:6186->6185`（回环绑定未变）；10/10 模块；QQ `Bot ONLINE — READY` |
| 新代码校验 | 部署前 `grep -c dsh_origin dist/ingest.js` = **0**；部署后 = **2** |

> ★ **为什么只换镜像**：SOP 里的 `alysia-deploy.tar.gz` 会覆盖服务器上的 `config.yml`，
> 而那份承载着 **2026-10-16 的线上改动**（`proactive.personalize` 256→1024、
> `session.summary` 2048→4096）与**回环绑定加固**（本地仓库的 `compose.yml` 里写的仍是未加固的
> `'6186:6185'`）。覆盖 = 静默回退这两件事。本次改动不涉及任何配置/compose 变更，故不打包配置。
> 部署后已核对：`config.yml` 第 73/86 行的两个值仍是 10-16 改过的，端口仍是 `127.0.0.1:6186->6185`。

## 2. 验收结果（生产库实测）

跑了两轮委托任务（第二轮用 `--session-id` 续作），然后只读查库：

```
===== 第一轮 =====
sessionId=session-98e3dcf3-3f23-4982-9e72-5b2c31a00989
final=B-DEPLOY-OK                                 EXIT=0
stderr: 会话来源标记已启用：dsh_origin=delegated-task —— …且**不做结算**

===== 第二轮（--session-id 续作）=====
final=B-TURN2-OK                                  EXIT=0

===== 生产库 =====
事件数 = 6
payload 标记分布：
  skip_profile=True synthetic=delegated-task dsh_origin=delegated-task → 6 条
该会话的 conversations（摘要）行 = 0                ← 期望 0

===== 回归：历史 dsh 事件（10-17 之前，抽样 200 条）=====
dsh_origin=None skip_profile=False → 200 条        ← 正常会话未被误伤
```

**结论**：
1. 委托会话的事件**逐条**被打上不学习闸（`skip_profile` + `synthetic`），来源事实（`dsh_origin`）留痕；
2. 该会话**没有产出摘要行**；
3. **正常 dsh 会话不受影响**（抽样 200 条全部无标记）；
4. `--session-id` 续作在真机上可用（顺带覆盖了 `connect-server-dsh-bridge` 未曾验证的那一段）。

## 3. ⚠️ 本节没验到的（不许当成验过）

- **「跳过结算」这条分支在本次真机运行里没有被执行到**：headless 是一次性进程，
  两次运行的 stderr 里**都没有** `session/disposed → 跳过结算` 这一行
  —— 也就是说 `session/disposed` 很可能**根本没触发**（进程先退出了）。
  「摘要行 = 0」因此**不能**用作「跳过结算生效」的证据，它同样能被「压根没结算」解释。
  该分支目前只有**单测**覆盖（`index.test.ts` 的那条「配了 → 不结算」）。
  它仍是必要的**防御**：一旦将来跑常驻运行体（或 dsh 在退出前补发 disposed），这条路就会走。
- 未验证 `--json` 事件流的终态字段在长任务下的形态（本轮任务太短）。

## 4. 顺带发现的仓库漂移（**未修，需立项**）

`packages/server/compose.yml` 里的端口行是 **`'6186:6185'`（无 IP 前缀 → Docker 绑全网卡）**，
而服务器上那份已被 2026-10-15 加固为 **`'127.0.0.1:6186:6185'`**。
⇒ **谁按 SOP 打包一次配置，就会把这条加固冲掉**（同 9-25 `server.host` 那个坑的形态：
仓库里的部署文件与线上不一致，且不一致的方向是**安全性下降**）。
本轮靠「只换镜像」避开，但这是**迟早要爆的**，应单独立项把仓库那份改成加固版。

## 5. 本轮在生产库新增的数据

| 内容 | 数量 | 状态 |
|---|---|---|
| E01 探测事件（未标记，部署前产生） | 9 条 / 3 会话 | **仍在**（待用户决定删或留） |
| 本次验收事件（已标记） | 6 条 / 1 会话 | 已正确标记；不入学习管道 |
