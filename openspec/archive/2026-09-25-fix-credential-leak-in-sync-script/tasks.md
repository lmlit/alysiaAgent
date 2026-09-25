# Tasks: fix-credential-leak-in-sync-script

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 实现走执行工具（subagent-driven-development / TDD），本文件只记账。

## 实现任务

- [x] 改 `packages/server/scripts/sync-from-server.sh`：删除硬编码默认值，改为
      「env `SUDO_PASS` > 凭据文件 > 报错退出」
- [x] ~~`.gitignore` 加入凭据文件路径~~ → **改为凭据文件放仓库树外，无需 gitignore**
      （设计变更：树内 + gitignore 是「约定」不是「保证」；树外才是物理隔离。见 proposal 决策 1）
- [x] 在本机创建凭据文件 `$HOME/.alysia-deploy-credentials`，填入**轮换后的新密码**（树外，不进仓库）
- [x] `docs/Docker-Deployment.md` 补凭据管理章节（含 8-28 事故教训与「树内 ≠ 安全」的推理）
- [x] 跑完测试计划，逐条留证据：
      - [x] 无凭据 → 打印指引 + **退出码 1**（实测通过）
      - [x] 凭据文件解析正确（长度 28，逐字比对一致）
      - [x] 环境变量优先于文件（`env-wins` 覆盖成功）
      - [x] 被跟踪文件扫描：**旧密码 0 命中、新密码 0 命中**
      - [x] 工作区（含未跟踪）扫描新密码：**0 命中**
      - [x] 凭据文件确认在仓库树外（`git check-ignore` 不适用 = 物理隔离成立）

### 遗留（不在本 change，需单独立项）

- [ ] SSH `passwordauthentication yes` → 建议改 `no`（仅 key 登录）。轮换已堵住入口，
      此为纵深防御；但**有锁死风险**，需用户确认后单独做
- [ ] pre-commit 凭据扫描（治「敏感内容进公开仓库」的习惯问题，8-09 已有同类事故）

## Apply 任务（实现完成后）

- [ ] 合并 `spec-memory.md` 到 `openspec/specs/memory-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`（状态/最后变更）
- [ ] 提交前敏感审查（对照 8-09 事故教训：确认本次改动未把凭据再写进任何被跟踪文件）
