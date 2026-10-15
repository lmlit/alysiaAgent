# Spec 变更: migrate-server-to-new-host

> **apply 说明**：本 change 只改 `memory-system` 的**一处** ——
> §「★ 8-28 运维工具：服务器数据同步」，**在现有 `★ 9-25 凭据外置` 段之后追加一个 `†` 段**。
>
> 锚点以 2026-10-15 的 `openspec/specs/memory-system/spec.md`（1022 行）为准：
> - **L983**：`` `packages/server/scripts/sync-from-server.sh`——手动脚本，把服务器（<SERVER_IP>，云端 appid ``
> - **L996-1009**：`★ 9-25 凭据外置（fix-credential-leak-in-sync-script）` 段
> - **L1001**：`- 凭据来源优先级：环境变量 SUDO_PASS > $HOME/.alysia-deploy-credentials > 报错退出；`
>
> ⚠️ 沿用 `add-theme-system` 起的改法：**不使用 `+`/`-` diff 标记**（理由见
> `clean-spec-diff-residue`；该 spec 末尾 L1018-1022 的 `+ ` 残留正是待清理对象，本 change 不制造新的）。
>
> ⚠️ **不写真实主机地址** —— 本文件在 PUBLIC 仓库内，沿用既有的 `<SERVER_IP>` 占位符。

---

## 追加：† 2026-10-15 迁移到新机（migrate-server-to-new-host）

**位置**：接在 L1009（`另开 change，不混在一起`）之后、L1011（`★ 8-28 分类容错`）之前。

以下为追加内容：

---

**† 2026-10-15 迁移到新机（migrate-server-to-new-host）**：

服务已从旧机迁至新机（<SERVER_IP>，root + SSH 密钥免密）。同步脚本随之调整**两处**，
L996-1009 的凭据纪律**继续有效、不被推翻**：

- **† 契约 1：目标主机必须可配置，默认值可运行。**
  `SERVER="${ALYSIA_SERVER:-root@<SERVER_IP>}"`。硬编码主机是本次迁移暴露的直接缺陷
  （换一台机器就要改脚本正文）；留默认值是为了不动脑即可运行，留 env 覆盖是为了下一次迁移
  与本地对着别的实例调试。**被否决**：写进 `config.yml` —— 那份文件是部署产物，
  本机与服务器共用一份会互相污染（同类事故：`server-bind-host` 的 `host:` 字段）。

- **† 契约 2：凭据要求是条件式的 —— 远程为 root 时无需凭据。**
  ```
  REMOTE_UID="$(ssh "$SERVER" 'id -u')"
  REMOTE_UID = 0  →  SUDO_PREFIX=""                          # 免凭据
  否则            →  走 L1001 的优先级链 + SUDO_PREFIX="echo '$SUDO_PASS' | sudo -S "
  ```
  前缀名取 `SUDO_PREFIX` 而非 `DOCKER_PREFIX`：实测 5 个调用点里有一个是 `sudo -S chown`
  （容器 → 宿主机取文件后的属主修正），不只 docker。  判断依据是**远程的真实身份**而非本机开关（开关会被忘记、会与实际不符，`id -u` 不会说谎）。

  ★ **这不是对 L1005 的削弱。** 原条款「两者皆无 → 打印指引并 `exit 1`，不回落默认值、
  不静默跳过」的**设计意图是「不许静默回落」**，不是「无论什么场景都必须有密码」。
  在 root 场景下「没有密码」是**正确状态**而非缺失 —— 此时仍要求密码会让一个本可正常工作的
  情况被判死（这正是迁移前的实际故障形态）。因此 L1005 **原文保留**，仅把适用条件
  明确为「远程非 root 且两者皆无」。

- **† 契约 3：取代与新增是两件事，分开提交。**
  本 change **只**改目标主机与凭据模型；`docs/Docker-Deployment.md` 的 SOP 更新属文档面，
  `.gitignore` 的 `.tools/` 属仓库卫生 —— 三者同属一次迁移的收尾，故合并为一个 change；
  但**旧机回收、凭据文件删除、LanceDB 瘦身**都不夹带（分别在旧机废弃、瘦身两个独立动作里做）。

**迁移事实（落地证据，供追溯）**：停机窗口约 2~3 分钟；`./data` 612M → 压缩 225M（剔除
`alysia.db.bak-*`）；旧机 → 新机直传约 11.6 MB/s；镜像 `save`/`load` 后 **15 层 digest 逐字节一致**
（`.Id` 差异仅因存储驱动不同：旧机 containerd snapshotter vs 新机 overlay2）；
`PRAGMA integrity_check` ok→ok；关键表计数（`ai_life_events` / `ai_life_daily_summaries` /
`ai_life_intents` / `conversations` / `worldbook_entries` / `life_templates` / `profile.facts`）
**逐项一致**；向量 2601→2602 行（+1 为迁移后新问候事件的向量，非丢失）；
模块 13/13 + 10/10；QQ 官方 `READY` 且**主动消息实发成功**（端到端证据）。
旧机保留为**回滚锚点**（数据原封不动），同机的 `astrbot` 容器全程未动。

---

## 明确不涉及

- **不改 L996-1009 的任何一行原文** —— 凭据外置的纪律（不硬编码、树外存放、不静默回落、
  不改写公开 git 历史）**全部继续有效**
- **不动 `docs/DEPLOYMENT.md`（对外指南）** —— 通篇 `<your-server>` 占位符，与具体主机无关
- **不动 core / server 代码、不动 Web API** —— 迁移不需要改应用
- **不写真实主机地址、实例 ID、RAM 用户 ID** —— 本文件在公开仓库内
- **不清理旧机、不删凭据文件** —— 回滚窗口（3~7 天）内两者都还要用
- **不做 LanceDB 瘦身** —— 独立 change（迁移纪律要求保真）
