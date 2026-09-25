# Change Proposal: fix-credential-leak-in-sync-script

## 元信息

- **日期**: 2026-09-25
- **类型**: FIX（安全修复）
- **状态**: archived（2026-09-25，实现+合并已完成）
- **影响 spec**: `memory-system`（§「★ 8-28 运维工具：服务器数据同步（server-data-sync-script）」）

## 动机（为什么做）

2026-08-28 的提交 `05a2651`（server-data-sync-script）把服务器 sudo 密码**明文硬编码**在
`packages/server/scripts/sync-from-server.sh` 第 11 行，形如 `SUDO_PASS="${SUDO_PASS:-<明文>}"`。

该提交已在 `origin/master`（**公开仓库**）上，暴露 28 天（8-28 ~ 9-25）。

> ⚠️ 本 proposal **刻意不复写该密码的值**——复述泄露证据是二次写入仓库的典型路径。
> 需要核对时用 `git log --all -S'<前缀>'`，不要把全文落进任何被跟踪的文件。

**影响面比预想更大**：经核验，该密码**同时是 `hexi` 账号的登录密码**，不是独立的 sudo 密码：

| 核验手段 | 结果 |
|---|---|
| python3 `crypt`（认 `$y$`/yescrypt）比对 `/etc/shadow` | MATCH |
| perl `crypt`（独立实现，交叉验证） | MATCH |
| 对照组：用**错误密码**试 `sudo -S` | 被拒 ⇒ 排除 sudoers NOPASSWD 放水 |
| `sudoers` 内容 | 仅 `admin` 配了 `NOPASSWD:ALL`，hexi 没有 |

服务器 `passwordauthentication yes`，端口公网可达。⇒ 读过仓库者可**直接 SSH 登录成 hexi
→ sudo 到 root → 读 `~/alysia/.env`（LLM Key / QQ AppSecret）与整个数据库**
（全部对话 / 画像 / 生活数据），并可任意改删。

**本 change 之前已完成的止损（记录在案）**：

- 服务器密码**已轮换**，旧密码验证为 `已失效`，新密码未进仓库、未进任何被跟踪文件
- 入侵核验：`last` 仅见 `admin`/`root` 且止于 8-12；`lastb` 为公网爆破噪声（`root`/`ubuntu`/`portfoli`
  等常见用户名），**无爆破成功记录**
- 服务器侧无残留：`grep -r` `/home/hexi` `/tmp` 为空；hexi 无 crontab

**本 change 只负责仓库侧**：去掉硬编码，并让"缺凭据"成为显式错误而非静默回落。

## 需求（做什么）

- [ ] `sync-from-server.sh` 删除硬编码默认值
- [ ] 凭据来源优先级：环境变量 `SUDO_PASS` → gitignored 的本地凭据文件
- [ ] 两者皆无 → 打印清晰指引 + `exit 1`（**不回落、不静默继续**）
- [ ] 凭据文件路径写入 `.gitignore`
- [ ] `docs/Docker-Deployment.md`（本就 gitignored 的内部部署文档）记录凭据文件的位置与用法
- [ ] 明确记录：**旧密码作废即可，不改写公开 git 历史**

## 设计决策（怎么做，含备选与取舍）

**决策 1：凭据外置为「env > gitignored 文件」，而不是塞进现有配置**

`config.yml` 路径确已 gitignore，但它服务**运行时**而非运维脚本；把运维凭据混进运行时配置
职责混淆，且 `config.yml` 曾被打包进部署包（见 `docs/Docker-Deployment.md` Step 3），
存在**再次外流**的路径。故新建专用的、单独 gitignore 的凭据文件。

**决策 2：不做"缺凭据就降级跳过"**

项目硬约束「不静默吞错」。缺凭据必须响亮失败——否则会退化成"脚本看着跑通了、
实际根本没连上服务器"，比报错更难排查。

**决策 3：不改写公开 git 历史**

密码已轮换 ⇒ 历史里的字符串已是**死密码**。改写公开历史需 force push、破坏所有既有克隆，
收益为零。记录在案即可。（若日后判定需要，须作为独立 change 并评估影响面。）

**决策 4：pre-commit 凭据扫描不在本 change 范围**

根因是"敏感内容进公开仓库"这一**习惯问题**（8-09 已有同类事故），值得单独一个 change
做提交前钩子。本 change 保持小步，不把两件事混在一起。

## 对账方向确认

- [x] 与现有 spec 冲突？**无**。spec 的「★ 8-28 运维工具」节只描述脚本的功能流程（在线导出→scp→
      备份→替换→校验→前置检查），**未涉及凭据从哪来** → 本 change 为**新增约束**，
      不改既有描述，无需改动既有行
- [x] 涉及 Web API？**不涉及**

## 测试计划

- [ ] `SUDO_PASS=<正确值>` → 正常进入后续流程
- [ ] **不设 `SUDO_PASS` 且无凭据文件** → 打印指引 + 退出码 1（关键用例，验证不再静默回落）
- [ ] 存在凭据文件 → 正确读取并继续
- [ ] 退出码断言：`echo $?` 必须为 1（不是 0、不是 127）
- [ ] `git check-ignore <凭据文件>` → 确认确被忽略（**防复发的关键断言**）
- [ ] 全仓库扫描：被跟踪文件中不含该密码串
