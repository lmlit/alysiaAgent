# 真机端到端记录：add-project-task-delegation（2026-10-17）

> 环境：生产 `alysia-server`（北京 `<server>`；**地址不入库**，见 `docs/Docker-Deployment.md`）+ 宿主 runner + 委托 profile `alysia`。
> 方式：`ssh … bash -s < e2e-c.sh`（本地写脚本、远端执行，避免 PowerShell 破坏引号）。

## 1. 部署（两次，第二次修了一个真 bug）

| 项 | 值 |
|---|---|
| 回滚锚点 | `server-alysia:rollback-20261017-101940`（= 部署前 latest） |
| 配置 | `/root/alysia/config.yml` **追加**了 `projects:` 段；备份 `config.yml.bak-20261017-101940` |
| 配置校验 | 重启前用 `yaml.safe_load` 校验；并核对 10-16 的两个 `max_tokens` **未被回退** |
| 容器 | `Up (healthy)`、`127.0.0.1:6186->6185`、10/10 模块、QQ `Bot ONLINE — READY` |
| 新代码 | `grep -c "project-tasks" dist/webui/server.js` = **7** |

### ★ 第一次部署失败：`未知项目 alysia-blog（已登记：无）`

容器里 `config.yml` 明明有 `projects:`，服务端却说「已登记：无」。
根因：**`loadConfig()` 是逐字段挑选的**（`packages/server/src/config.ts`），
我只加了类型、**没加映射** ⇒ 新配置段被**静默丢弃**。

> 这正是本项目反复栽的那类「配置写了但没人看见」。值得记的是：**它是被上游的
> 响亮拒绝逼出来的**——路由回的是「未知项目 alysia-blog（已登记：无）」，
> 而不是「接受了一条根本没人会跑的任务」。如果当初写成「接受并排队」，
> 这个 bug 会一直躺着，表现为「任务提交成功但永远不动」。

修法：显式映射 + `sanitizeProjects()`（坏条目**留痕**而不是静默丢），
并在 `config.ts` 里写明「这个函数是逐字段挑选的，加配置段必须同时改这里」。

## 2. 端到端结果（脚本输出摘录）

```
1. 建任务        → {"ok":true,"reason":"created","task":{...,"status":"queued","revision":0}}
2. 同 requestKey → reason=deduped task=pt-7a922b11…        ← 没建第二个
4. runner --once → 认领 pt-7a922b11…（revision 0，第 1 次）
                   将执行：dsh --profile alysia --json <task>
                   dsh 退出码 0，用时 9s，turn_end.reason=completed
                   已回传：needs_review
5. 查任务        → status=needs_review revision=0 attempts=1
                   dshSessionId=session-01e1293b-b03c-4d10-863d-643c6b674363
                   result.final=C-E2E-OK
6. 追加修改      → revision=1 status=queued dshSessionId=session-01e1293b…（不变）
7. 第二轮 runner → 认领（revision 1，第 2 次）
                   dsh --profile alysia --json **--session-id session-01e1293b…** <task>
                   dsh 退出码 0，用时 11s → 已回传 needs_review
8. 第二轮结果    → revision=1 dshSessionId=session-01e1293b…（**同一个会话**）
9. 工作区        → ✅ 跑前跑后一致（零副作用）
10. 记忆标记     → dsh:session-01e1293b… 6 条事件**全部**
                   skip_profile=True / synthetic=delegated-task / dsh_origin=delegated-task
                   摘要行 = 0
```

⇒ 「建任务 → 认领 → 执行 → 回传 → 追加意见 → **同一会话续作**」**整条链在生产上通了**，
且**零副作用**、**委托会话不进记忆**（B 的契约在新链路里仍然成立）。

## 3. ⚠️ 一处**没解释通**的观察（不许当成通过）

**第二轮的 `result.final` 仍然是 `C-E2E-OK`，而不是要求的 `C-E2E-ROUND2`。**

可能的原因（**未定位**，按「先取证再改」的纪律只记录）：
1. 模型在同会话里把上一轮的约定当成了持续指令，回答了旧码 —— 属**指令遵循**问题；
2. `final` 取到的是**该轮最后一条 assistant 文本**，而模型可能先答旧码再说别的（本轮只有一条）；
3. 续作时任务正文的拼装方式让「新要求」不够突出（`buildTaskText` 把 feedback 当 goal 传，
   理论上正确，但模型看到的是「第 2 轮」提示 + 新 goal）。

**影响**：任务状态机、会话续作、记忆隔离都不受影响；受影响的只是「我怎么确认她真的按要求做了」。
⇒ 这正是 E02/E03 要面对的**验收**问题（不是执行链路问题）。
本 change 的测试全部是契约层的，**没有**断言「模型会照做」。

## 4. 本轮在生产库新增的数据

| 内容 | 数量 | 状态 |
|---|---|---|
| 任务表 | 1 条（`pt-7a922b11…`，revision 1，needs_review） | 可删（纯 e2e 探测） |
| 委托会话事件 | 6 条（已正确标记） | 不入学习管道 |
| 工作区文件 | 0（未变） | — |
