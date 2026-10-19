# 委托任务 / 她做东西 的 SOP

> 2026-10-18 建立。起因：她**自己发起**的「慢时钟」被放进了 `alysia-blog`（正式项目）——
> 不是她笨，是**没有任何一处写清"你的两个项目怎么分工"**。
> 这份文档就是那个缺口：**人看的流程 + 她看的规则**，分开写。

## 0. 一句话分工

| 谁 | 负责什么 |
|---|---|
| **她（委托运行体）** | 在**自己的工作区**写页面、自己拍图自查、自己 `publish.sh` 发布 |
| **宿主 runner** | 认领任务、以非 root 跑 `dsh`、把结果回传 |
| **服务端** | 任务表 / 状态机 / 执行窗口闸门 / 结果回送 / 自发起判定 |
| **人（我们）** | 项目登记、工作区铺设（`AGENTS.md`/`publish.sh`/`shot.sh`）、网关与端口、镜像部署 |

> ⚠️ **她永远改不了基础设施**：起服务、改端口、写 systemd、动 `/root` —— 全在边界外。
> 这是设计，不是缺陷（见 `project-tasks` spec §6.1）。

## 1. 项目分工（她最容易放错的地方）

| 项目 | 工作区 | 放什么 |
|---|---|---|
| `alysia-blog` | `<workspace>/blog` | **正式页面**（关于我、正经文章） |
| `alysia-toys` | `<workspace>/toys` | **小玩具 / 试验 / 自发起的东西** |

规则：**"这是长期代表她的正式页面，还是随手玩的？"** 随手玩的进 toys。
**她自己发起的活一律进 toys** —— 这不靠她自觉：`selfActivity.projectId` 在配置里写死。

一个项目可以有多个页面，**基站按"页面"列卡片**（每个 `public/*.html` 一张；`index.html` 的地址是
`/p/<项目>/`，其余是 `/p/<项目>/<文件名>`）。
仍然建议在首页加相对链接（`href="slow-clock.html"`，不能是 `http://`，那算外链会被自检拦下）——
从基站点进首页之后，还能在首页里逛。

## 2. 她的发布契约（她自己的活）

工作区里有三个文件是她要知道的：

| 文件 | 作用 |
|---|---|
| `AGENTS.md` | 她的说明书（dsh 会话开始时自动加载）：项目分工、发布目录、基站目录、能用什么工具 |
| `publish.sh` | 一条命令完成「复制 → 自检 → 打印地址」；四条判据任一不过即非零退出 |
| `shot.sh` | 相机：把页面拍成图（默认深色），**她自己打开看**；`--vision` 是旁路 |

四条发布判据：文件存在 → 与源文件逐字节一致 → **零外链** → 她的页面地址返回 200。

## 3. 人这一侧：加一个项目 / 加一个页面

### 加项目（新工作区）

1. `config.yml` 里登记：`projects.<id>: { workspace, profile, publicUrl }`
   - ⚠️ `loadConfig()` 是**逐字段挑选**的 —— 只加类型不加映射 ⇒ 配置被**静默丢弃**（踩过两次）
2. 铺工作区：`AGENTS.md` + `publish.sh` + `shot.sh` + `.alysia-project.json`
3. 重启容器（config 是启动时读的）→ 基站 10 秒内自动多一张卡（`alysia-preview-hub.timer`）

### 加页面（同一项目内的第二页）

页面放工作区根 + 复制进 `public/`，然后**在首页加相对链接**。基站不会为第二个页面单独出卡片。

## 4. 执行窗口（省钱闸门）

**高峰**（北京时间，工作日、非法定节假日）：9:00–12:00、14:00–18:00 ⇒ **只排队不执行**。
其余（含周末、节假日全天）可跑。

- 查现状：`GET /api/project-tasks/window` —— 回答"我的任务为什么不动"
- **节假日表要人填**（`projectTasks.holidays`），不内置（每年公布 + 调休，猜错更糟）
- 排障时钟 `projectTasks.nowOverride`（**配了会 WARN**，验证完删掉）

## 5. 她自己发起（自主性边界）

六道护栏：开关 → 空闲时段 → 无在途 → 日上限（默认 1）→ 间隔（24h）→ **用户已安静（6h）**。
**默认不发布**：她定做什么，"上线"留给对话里的人。

## 6. 部署（人）

只换镜像，**不动配置**（`docs/Docker-Deployment.md` 有完整 SOP 与回滚做法）：

```
构建 → save → scp → load → compose up -d → 健康检查
```

**★ 三条硬规矩（都因真实事故立的）**：

1. **构建必须成功才能往下走**。`docker compose build` 返回非 0 时继续 `save` ⇒ 部署的是**旧镜像**
   （"改动没生效"的假象，踩过三次）。→ 用重试循环，失败即中止。
2. **load 完立刻验标记**：`docker exec … grep <新符号>`，不通过就停，别在旧镜像上做实验。
3. **配置改动只追加、不改写**：服务器 `python3` 是 3.6，PyYAML 不支持 `safe_dump(sort_keys=…)`；
   改写整份 YAML 还会**丢掉注释**。→ 备份 + `printf` 追加 + `yaml.safe_load` 校验。

## 7. 本次踩过的坑（会重复出现的那些）

| 坑 | 症状 | 原因 / 做法 |
|---|---|---|
| 模块 `provides` 没声明 | **整个服务起不来**、容器重启循环 | `ctx.provide(x)` 必须配 `provides:[x]`；否则不是"模块挂了"是全站挂了 |
| 部署了旧镜像 | 改动静默无效 | 见 §6 第 1、2 条 |
| 预览服务单线程 | 页面**间歇性打不开**（`000`） | 服务器 python 3.6 的 `http.server` 是单线程 ⇒ 用 `scripts/preview-serve.py`（`ThreadingMixIn`） |
| `SimpleHTTPRequestHandler(directory=…)` | 全部 000 | 该参数是 **3.7+**，3.6 上用 `os.chdir` |
| 越界防护用 `realpath` | 页面静默回落成基站首页（大小变 2455B） | `p/<项目>` 本来就是符号链接 ⇒ 只做**词法**校验 |
| 提示词 `max_tokens` 给小 | 返回空串（`finish=length`） | KI-1；给自己留 800 以上 |
| 回执写成 `role: 'assistant'` | prompt 里出现「昔涟: （委托任务回执）…」，**冒充她说话** | 用 `engine` 归属 + `dialogueSpeaker()`，见 spec §15 |

## 8. 异步唤醒：结果回来之后谁说话（2026-10-19 立）

以前：`dsh` 跑完 → 服务端**自己**写一条通知、直接推 QQ。她只是"被记了一笔"，
没有机会验收、返工或决定怎么跟你说。线上 31 条任务**全部停在 `needs_review`、0 条验收** ——
闭环从来没合上过。

现在：

```text
结果落库（同一事务入队）→ 调度器领取 → 跑**完整一轮主 Agent**（人格/记忆/工具）
→ 她自己决定：验收(accept_project_task) / 返工(continue_project_task) / 问用户 / 汇报
→ 她的回复走既有 QQ 通道
```

| 概念 | 在哪 | 说明 |
|---|---|---|
| 待处理事件 | 表 `project_task_events` | outbox：`pending→claimed→done/failed/dead`，**重启不丢** |
| 调度器 | `al:subagent-wake` | 进程内轮询（默认 5s），**不新开 HTTP 入口** |
| 结果输入 | `PipelineExtras.subagent_result` | 明确标成「工具返回，不是用户说的话」；**不写进 EventLog** |
| 三态 | `status` / `accepted_at` / `notified_at` | 跑完 ≠ 她认了 ≠ 说出口，三件事分开记 |
| 验收入口 | `POST /api/project-tasks/:id/accept` | 只有 `needs_review` + revision 匹配才写 `completed` |
| 返工幂等 | `continue_project_task(fromEventId)` | 同一条结果重复处理不会排两轮 |
| 证据 | `evidence.fresh`（产物 mtime ≥ 本轮开始） | 旧文件/旧截图不能当本次成功的证据 |

**配置（`config.yml`）**：`subagentWake.enabled / maxAutoRework / autoAccept / intervalMs / turnTimeoutMs`。

**回退（出事时按顺序试）**：

1. `subagentWake.enabled: false` → 回到旧的一次性通知 + 直接推送；**任务与产物一个都不删**；
2. `subagentWake.maxAutoRework: 0` → 保留唤醒，但**不许自动返工**（只能验收/汇报/问人）；
3. `subagentWake.autoAccept: false` → 保留唤醒，但 `completed` 只能由人写；
4. 普通 QQ 聊天**任何时候都不依赖**上面这些开关（它们是同一条管线上的增值段，不是前置条件）。

**排障**：

```bash
# 队列里还有什么、卡在哪个状态
docker exec alysia-server node -e "..."   # 或直接看日志里的 [subagent-wake]
grep -E '\[subagent-wake\]|\[project-task\]' logs/server.log | tail -50
```

`pending` 长期不降 = 调度器没跑或目标不合法（非 QQ 私聊会 ack 并留痕）；
`dead` = 试满次数放弃了（原因在 `last_error`，不会静默）。

## 9. 相关文档

- 契约：`openspec/specs/project-tasks/spec.md`（§6.1 权限、§10 回送、§11 基站、§12 认领、§14 窗口、
  §15 归属、§16 自发起、**§18 异步唤醒**）
- 治理：`openspec/project.md`
- 部署：`docs/Docker-Deployment.md`（含地址，**不上库**）
- 实验记录：`docs/E02-E03-ABOUT-PAGE-RECORD.md`
