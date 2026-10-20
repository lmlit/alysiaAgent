# Change Proposal: remove-dead-root-config

## 元信息

- **日期**: 2026-10-20
- **类型**: FIX（清理类，零行为变更）
- **状态**: pending → 本轮直接 apply
- **影响 spec**: `alysia-architecture`（§6 部署/启动入口那张表补一行「只有一份 config.yml」）
- **KI**: KI-8

## 这条要解决什么

根目录的 `config.yml` 是**死文件**：服务从 `packages/server` 启动，读的是
`packages/server/config.yml`。两份内容已经漂移（根目录那份缺 `webuiToken` 等行）。

改错文件**毫无提示**——这是已经真实发生过的事故：`server-bind-host` 那次
**第一版就写错了文件，实测没生效才发现**（见 `docs/HANDOFF.md` 相关节）。

## 取证（删除前必须确认的事）

| 要确认的 | 结论 |
|---|---|
| 有没有从根目录启动的入口？ | ❌ 根 `package.json` **没有 `start` 脚本**（只有 test/build/dev:server/dev:console） |
| 文档里怎么说的？ | `docs/HANDOFF.md` 明文「改配置只改 `packages/server/config.yml`」 |
| 谁在读根目录那份？ | 无。`packages/server/src` 的配置读取路径指向自己目录 |

## 需求

- [ ] `git rm config.yml`（只删根目录那份，`packages/server/config.yml` 一字不动）
- [ ] `alysia-architecture` spec 的启动/部署节补一句「配置只有一份，在 `packages/server/`」
- [ ] KNOWN-ISSUES KI-8 标已修 + 销账 TODO 表

## 不做

- **不合并/不改** `packages/server/config.yml` 的内容
- 不加「读到旧文件就报警」的机制（文件没了就不存在这个坑）

## 对账方向

KI-8 是 impl 与「说清楚配置在哪」之间的落差 → **删文件**（不是加注释），
因为注释只能提醒读过的人，而删掉是**机器能保证**的。
