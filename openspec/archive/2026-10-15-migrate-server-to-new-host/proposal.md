# Change Proposal: migrate-server-to-new-host

## 元信息

- **日期**: 2026-10-15
- **类型**: MODIFY（运维脚本的目标主机与凭据模型）+ DOC（部署 SOP）
- **状态**: archived（2026-10-15 迁移完成、脚本与文档落地、逐项对数验证通过）
- **影响 spec**: `memory-system`（§「★ 8-28 运维工具：服务器数据同步」——服务器标识与凭据契约）
- **发现于**: 用户 2026-10-15「我搞了一台新服务器，想把服务迁过去」

> ⚠️ **本文件在 PUBLIC 仓库内**。真实主机地址 / 实例 ID / RAM 用户 ID 一律用
> `<SERVER_IP>` 之类的占位符——真实值只存在于两个 **gitignored** 文件
> （`packages/server/scripts/sync-from-server.sh`、`docs/Docker-Deployment.md`）
> 与 `$HOME` 下的树外凭据。这是 8-09 / 8-28 两次泄露事故的既有纪律。

## 动机（为什么做）

服务**已经完成迁移**（见下「迁移事实」），旧机降级为回滚锚点。但仓库侧还停在旧机：

1. **`sync-from-server.sh` 会把同步打到已经停机的旧机上**——硬编码 `SERVER="hexi@<OLD_SERVER_IP>"`
   是本次迁移暴露的直接缺陷：换一台机器就要改一次脚本正文。
2. **凭据模型与新机不匹配**——新机是 **root + SSH 密钥免密**，而脚本强制要求
   `SUDO_PASS`（env > 凭据文件 > 报错退出）。结果是：**一个本来能正常工作的情况被判死**，
   脚本第 24-29 行会直接 `exit 1`。
3. **部署 SOP 失效**——`docs/Docker-Deployment.md` 的前置条件、架构图、Step 4 与日常运维
   全部指向旧机，且默认「非 root + sudo 密码」的操作方式。

## 迁移事实（本 change 的背景与证据）

本次迁移已完成并验证，记录在此以便追溯：

| 项 | 结果 |
|---|---|
| 停机窗口 | 约 2~3 分钟（打包 31s + 直传 19s + 解包启动约 40s） |
| 数据量 | `./data` 612M → 压缩 225M（剔除 14M 的 `alysia.db.bak-*`） |
| 直传速率 | 约 11.6 MB/s（旧机 → 新机，跨地域公网） |
| 镜像保真 | `docker save`/`load` 后 **15 层 digest 逐字节一致**（`.Id` 不同仅因存储驱动差异：旧机 containerd snapshotter vs 新机 overlay2） |
| `PRAGMA integrity_check` | ok → ok |
| 关键表计数 | `ai_life_events` 615 / `ai_life_daily_summaries` 67 / `ai_life_intents` 79 / `conversations` 230 / `worldbook_entries` 95 / `life_templates` 43 / `profile.facts` 84 —— **逐项一致** |
| 向量库 | 2601 → 2602 行（+1 为迁移后新产生的问候事件向量，非丢失） |
| 模块装配 | 13/13 + 10/10 |
| QQ 官方 | `✅ Bot ONLINE — READY`，且启动后**主动消息实发成功**（端到端证据） |
| 旧机 | 保留（数据 612M 原封不动）= **回滚锚点**；同机 `astrbot` 容器**全程未动** |

## 需求（做什么）

- [ ] `sync-from-server.sh`：目标主机改为 **`ALYSIA_SERVER` 环境变量 + 默认值**，
      不再要求改脚本正文
- [ ] `sync-from-server.sh`：凭据模型**条件化**——远程 uid 为 0（root）→ 无需凭据；
      否则维持原优先级链
- [ ] `docs/Docker-Deployment.md`：前置条件 / 架构图 / Step 4 / 日常运维 / 回滚
      全部更新到新机与「root 免密」操作方式
- [ ] `.gitignore`：忽略 `.tools/`（本机运维工具落点，见设计决策 4）

## 设计决策（怎么做，含备选与取舍）

### 1. 目标主机走 env 覆盖，而不是「再硬编码一次」✅

```bash
SERVER="${ALYSIA_SERVER:-root@<SERVER_IP>}"
```

**理由**：硬编码是本次的痛点本身（换机 = 改正文）。留默认值是为了不动脑就能跑；
留 env 覆盖是为了下一次迁移、以及本地对着别的实例调试时不用改文件。

**被否决**：把主机写进配置文件（`config.yml`）——那份文件是**部署产物**，会被打包上传，
本机与服务器共用一份会互相污染（同类事故：`server-bind-host` 的 `host:` 字段）。

### 2. 凭据分支用「远程 uid 探测」，而不是加 `--no-sudo` 开关 ✅

```bash
REMOTE_UID="$(ssh "$SERVER" 'id -u')"
if [ "$REMOTE_UID" = "0" ]; then
  DOCKER_PREFIX=""                    # root 直连，免凭据
else
  <原优先级链：env SUDO_PASS > 凭据文件 > 报错退出>
  DOCKER_PREFIX="echo '$SUDO_PASS' | sudo -S "
fi
```

**理由**：判断依据是**远程的真实身份**，不是本机的一个开关——开关会被忘记、
会与实际不符，而 `id -u` 不会说谎。

**被否决**：
- `--no-sudo` 命令行开关 —— 多一个会忘记的旋钮
- 直接删掉整个 sudo 分支 —— 下一个非 root 服务器又要重写一遍，且会让
  `fix-credential-leak-in-sync-script` 立下的凭据纪律失去落点
- 在 root 场景也照旧 `echo $SUDO_PASS | sudo -S` —— root 下 sudo 通常不要求密码，
  但**要求一把无意义的密码**正是当前把脚本卡死的那个 bug，不能靠"恰好也能过"掩盖

### 3. spec 里**不写新机地址**，继续用 `<SERVER_IP>` ✅

`openspec/` 跟踪在公开仓库内。spec 自建立之初就用 `<SERVER_IP>` 占位符，
本 change **沿用**——真实地址写进 gitignored 的 SOP 与脚本。
（这条不是洁癖：8-28 的密码正是因为"文件在仓库树内 + gitignore 只是约定"而暴露 28 天。）

### 4. `.tools/` 进 `.gitignore` ✅

本机运维工具（阿里云 Workbench CLI 的 14MB 二进制、迁移脚本、基线探针）**只能**落在工作区内。
`git status` 里"未跟踪但未忽略"正是 8-09 事故的形态（`.gitignore` 第 24-27 行的既有注解），
所以直接忽略，而不是靠"记得别 add"。

## 对账方向确认

- [x] 是否与现有 spec 冲突？**不是冲突，是扩展一个分支**。
  `memory-system` 现契约写「两者皆无 → 打印指引并 `exit 1`，不回落默认值」。
  该条款的**设计意图**是「不许静默回落」，而不是「无论什么场景都必须有密码」。
  新机是 root 免密 —— 此时"没有密码"是**正确状态**而非缺失。
  → 方向为 **doc 补分支 + impl 同步**，两端一致；**不删**原条款（非 root 服务器仍然适用）。
- [x] 涉及 Web API？**不涉及**（不动 `docs/Web-API-Design.md`）。
- [x] 涉及 core / server 代码？**不涉及**（只动运维脚本与文档）。

## 测试计划

- **root 分支**：新机上不设 `SUDO_PASS`、不存在凭据文件 → 脚本应正常走完全流程
  （在线导出 → scp → 校验 → 替换本地库），**不得**在第 24-29 行退出
- **非 root 分支回退保证**：`ALYSIA_SERVER` 指向一个非 root 用户、且不给凭据 →
  应打印指引并 `exit 1`（原契约的关键用例，不能被本次改动破坏）
- **完整性**：导出库 `PRAGMA integrity_check` = ok，且关键表计数与线上一致
- **本地安全**：替换前必须产生 `alysia.db.bak-<时间戳>`（回滚锚点）
- **文档**：SOP 中不再出现旧机地址；`docs/Docker-Deployment.md` 通读一遍步骤可执行
