# Tasks: attribute-engine-receipts

> **状态（2026-10-18）**：T1–T5 完成，生产验证。

## 实现

- [x] **T1** 新增 `packages/core/src/memory/render-dialogue.ts`
      - `dialogueSpeaker(role, labels?)`：`user` → 你 / `assistant` → 昔涟 / **`engine` → 工程端**
      - **未知 role 仍当作她**（历史数据兼容；加新角色不能把老数据渲染成别人）
- [x] **T2** 三处渲染器改用共享函数（原来是各自的三元表达式）
      - `MemoryManager.getRecentDialogueBlock`
      - `pipeline/stages/memory-retrieval`
      - `pipeline/stages/llm-agent`（标签用「伙伴」）
- [x] **T3** 回执事件：`payload.role = 'engine'`（原来是 `assistant`）
- [x] **T4** 正文首行 `【工程回执·来自 dsh 执行端】…`（双保险：即使渲染标错也不会被误读）
- [x] **T5** 记忆回执**不再**使用 `composeProjectTaskNotice()` 的产物
      - 她的口吻**只用于 QQ 推送**
      - `MemoryManager.recordProjectTaskResult` 的 `notice` 标为**已废弃**（保留字段不破坏调用）

## 测试

- [x] `render-dialogue.test.ts`（6）：三种说话人标签、**未知 role 仍当作她**、标签可覆写
- [x] `project-task-result.test.ts` 改契约：`role=engine`、首行带来源、**传了 notice 也不许写进正文**
- [x] 路由测试改契约：**她的措辞只进推送**，落库那条不带 `notice`
- [x] 全仓 **120 文件 / 1475 用例** 绿

## 真机验证（生产）

```
回执事件 role = engine            （旧：assistant）
正���首行 = 【工程回执·来自 dsh 执行端】项目 alysia-blog 第 1 轮已结束：needs_review。
markers  : skip_profile=True  synthetic=project-task-result  project_task_result=True
推送     : Proactive send → OK（仍是她的口吻）
容器内标记: dialogueSpeaker 出现在 MemoryManager(2) / memory-retrieval(3) / llm-agent(2)
```

⚠️ **未直接观察**：那一轮之后没有真实 QQ 对话，所以**没有亲眼看到 prompt 里的渲染结果**。
渲染路径由单测覆盖（`dialogueSpeaker` + 三处调用点），存储侧已确认为 `engine`。

## ★ 过程中的第三次同类翻车（必须记下来）

部署又双叒撞上「**旧镜像**」：`docker compose build` 返回非 0（境外基础层拉取失败），
而我这次**只打印了 BUILD 值没检查**，于是 `docker save` 打的是旧镜像 ⇒ 验出来 `role=assistant`，
看起来像"改动没生效"。

修法：构建改成**硬循环**（最多 6 次、失败即中止），并且 **load 后立刻 grep 新标记**，
不通过就不往下做实验。

> 前两次同类事故：① PyYAML `sort_keys` 把配置写失败；② 构建失败但继续部署。
> 共同点：**"命令返回了"不等于"动作成功了"** —— 每一步都要有可验证的产物检查。

## 未做

- [ ] 不迁移历史回执（事件表是不可变日志；旧回执仍带 `synthetic`，影响面有限）
