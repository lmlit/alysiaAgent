# 服务器 dsh 现状盘点（2026-10-17，**只读**）

> 授权：用户明确放行「一次只读的线上核对」。
> 本盘点**只执行读取命令**（`ls` / `cat` / `ps` / `ss` / `free` / `df` / `docker ps` / `grep`），
> **未改任何文件、未重启任何服务、未写入任何目录**。
> 起因：用户指出「我们现在服务器是什么情况，不是有一个 dsh 了吗」——
> 核实结果：**用户是对的**，可行性分析里「服务器上没有 dsh」那条判断错误（见 §4 更正）。

## 1. 主机与运行时（实测）

| 项 | 值 |
|---|---|
| 主机 | `root@<server>`（阿里云 ECS 北京，`ecs.e-c1m1.large`；**地址不入库**，见 `docs/Docker-Deployment.md`） |
| 内核 / 架构 | Linux 5.10.134-19.8.al8.x86_64，2 vCPU |
| 内存 | **1870 MB 总 / 已用 662 MB / 可用 1208 MB**；swap 4095 MB（用 87 MB） |
| 磁盘 | `/dev/vda3` 40G，用 13G（33%），剩 25G |
| Node | **v24.21.0**（`/opt/node/bin/node`） |
| pnpm | 11.7.0（`npm -g` 提供） |
| **dsh** | **`@deepseek-ai/dsh@0.2.0-rc.2`，全局安装**（`/opt/node/bin/dsh`）——**与桌面端同版本** |

⇒ 可行性分析里「需要先解决 Linux 运行体获取」这一条**已经不成立**：它早就装好了。

## 2. 服务器 dsh 的实际装配（实测）

`DSH_HOME=/root/.dsh`（**创建于 2026-10-15 22:30，即服务器迁移当晚**）：

```
/root/.dsh/
├── .credentials.yaml     # 161 B（内容未读、未打印）
├── profiles/
│   ├── headless/         # bundles = dsh-base + dsh-headless，patch = []
│   └── web/              # bundles = dsh-base + dsh-web-app + ds-harness-remote
├── remote/servers/<id>/  # host/ 与 client/ 两套 device.key / device.json / trusted-peers.json
├── sessions/
│   ├── --root--/                          # 1 个会话
│   └── --root-alysia-ops--/               # 3 个会话（共 312 KB）
└── storages/
```

**★ 有一个 dsh 正在运行**（`ps` 实测）：

```
PID 13834  node /usr/local/bin/dsh --profile web --no-open --port 3080   (自 10-15 起，RSS 193 MB)
LISTEN 127.0.0.1:3080
```

**★ 远程通道已经具备**：web profile 装了第三方插件
[`ds-harness-remote@0.5.7`](https://github.com/liguobao/ds-harness-remote)
（"End-to-end encrypted remote access to DeepSeek Harness … from desktop, web, and Android"，
WebRTC + 设备密钥）。`/root/.dsh/remote/servers/<id>/` 下的 `device.key` / `trusted-peers.json`
就是它的配对资料。

⇒ 可行性分析里「驱动远端 dsh 需要新开入站通道、且只能用 GUI 内部 API」这一条**也需要修正**：
**官方形态的远程入口已经装好并在跑**（第三方插件，非 GUI 私有协议）。

## 3. 它**已经实际干过活**（这是最重要的发现）

`/root/alysia-ops/` 是一个**已经在用的 dsh 运维工作区**：

| 文件 | 作用 |
|---|---|
| `CLAUDE.md` | 运维手册：容器名、路径、`alysia.sh` 用法、**六条硬规矩**（`/root/alysia/data/` 是她的记忆，绝不删；停容器前先问用户；不改 QQ 凭据；同 AppID 不能双实例…） |
| `AGENTS.md` | 指向 `CLAUDE.md` |
| `alysia.sh` | 一行式运维助手（`status` / `health` / `logs` / `errors` / `stats` / `restart` / `api <path>`；token 从 `/root/alysia/.env` 读） |
| `watch.sh` + `watch.log` | 60 秒健康守护循环（跑在 **bwrap 沙箱**里，`--ro-bind /`）；只在异常时追加日志 |
| `CHANGELOG.md` | **运维变更日志**（10-16 16:08 更新，6808 B） |

**CHANGELOG 里记录了一次真实的生产修复**（2026-10-16，操作人写的是「运维 agent（受用户指令）」）：

- 问题 A：主动问候发**空消息** —— `[LLM] returned EMPTY content — max_tokens 预算耗尽（推理吃光）`，
  槽位 `sampling.proactive.personalize`，旧值 256；
- 问题 B：会话摘要首轮被截断 —— `reasoning=1912/1973` 吃满 2048，JSON 被截断（重试才成功）；
- 改动：`/root/alysia/config.yml` 里两个槽位 **256→1024**、**2048→4096**，并**从注释状态解除注释**；
- 配套：备份 `config.yml.bak-20261016-150436`、回滚命令、重启后即时验收（容器 healthy、
  容器内值已生效、QQ `Bot ONLINE — READY`、启动阶段 ERROR 0 条）；
- 遗留观察项：`life.generateSummary` / `profile.deepRewrite`（默认 2048，与历史事故同源）**本次未动**。

⇒ 也就是说：**「让 dsh 里的 agent 去操作 alysia」这件事，已经在生产上跑通了**，
只不过发起方式是人工（手机/桌面），而不是聊天侧 Alysia 自动委托。

## 4. ★ 必须更正的两条结论

| 我在可行性分析里写的 | 实测 | 影响 |
|---|---|---|
| 「dsh 在 Windows 桌面上；**服务器上没有 dsh**」 | ❌ **错**。服务器 10-15 就有 dsh 0.2.0-rc.2，**且正在运行** web profile（:3080） | A02/A05 的原文前提**成立**；而且反向通道已存在 |
| 「服务器可用内存 ~180MB，跑 dsh + 工具链很可能 OOM」（E16） | ❌ **数据是旧机的**。KNOWN-ISSUES 那段写的是杭州旧机（1613 MB / ~180 MB 可用）；**北京新机 1870 MB / 可用 1208 MB**，dsh web 常驻仅占 193 MB | 资源门槛**大幅缓解**；不再是否决性风险 |

（两条的来源都是本仓文档：HANDOFF / KNOWN-ISSUES 描述的是**旧机**，且只记桌面端 dsh，
没有记 10-15 迁移时在新机上装的这套东西。**这就是"不看机器只看文档"的代价**。）

## 5. 真正缺的那一件（也是本期该做的）

服务器 dsh **没有** Alysia 人格/记忆桥接：

- `profiles/web/package.json` 只有 `dsh-base` + `dsh-web-app` + `ds-harness-remote`，
  **没有 `@alysia/dsh-adapter`**；
- `$DSH_HOME` 下**没有** `cordis.patch.yml`，**没有** `.agent-presets/`；
- `grep -ril alysia /root/.dsh/profiles/` → **0 命中**。

⇒ 所以「dsh 的 **Alysia 模式**」在服务器上**还不存在**。要打通，缺的是：

1. 把 `@alysia/dsh-adapter` 装进服务器那个 profile（bundle 形态）；
2. 加一个人设/记忆的 patch 层，**`alysiaBaseUrl` 要指 `http://127.0.0.1:6186`**
   —— ⚠️ **不是 6185**：6185 是**容器内**端口，宿主机上是 6186（`127.0.0.1:6186->6185`）；
3. 给博客项目建一个像 `alysia-ops` 那样的固定工作区（含自己的 `CLAUDE.md` / 助手脚本）。

这三件都是**在服务器上加装配**，不需要新机器、不需要新通道、不需要改本仓的 core。

## 6. 本次盘点**没有**做的（不要当成结论）

- **未读** `.credentials.yaml` 内容、未读 `/root/alysia/.env` 内容（凭据一律未取）；
- **未验证**服务器 dsh 能否真的调通 LLM（没有跑任务——按要求只读）；
- **未验证** `ds-harness-remote` 的实际可用性（没从桌面连过，只看到装好且在跑）；
- **未检查**服务器上的 `session` 内容（那是用户与 dsh 的对话记录）；
- **未改**任何文件、未重启任何服务、未部署任何东西。
