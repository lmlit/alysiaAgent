# Change Proposal: attribute-engine-receipts

## 元信息

- **日期**: 2026-10-18
- **类型**: FIX（归属正确性）
- **状态**: archived（2026-10-18 归档；T1–T5 完成，生产验证）
- **影响 spec**: `project-tasks`（§15 新增 + §10.1 标注被取代）
- **前置**：`return-project-task-result`（回执本身）

## 动机（用户原话）

> 「我们工程的回执是不是要上下文带上，不如让自己调工程的回复，**她以为是我命令输出的**」

这是一个**归属性 bug**，比"文案干不干"严重得多。

旧实现把回执写成 `payload.role = 'assistant'`，而三处渲染器都是
「不是 user 就当成她」：

| 渲染器 | 旧代码 |
|---|---|
| `MemoryManager.getRecentDialogueBlock` | `role === 'user' ? '你' : '昔涟'` |
| `pipeline/stages/memory-retrieval` | 同上 |
| `pipeline/stages/llm-agent` | `h.role === 'user' ? '伙伴' : '昔涟'` |

⇒ prompt 里出现的是：

```
[23:41] 昔涟: （委托任务回执）项目 alysia-blog 第 1 轮已结束：needs_review。
```

**等于替她写了一段她没说过的话。** 后果有两个方向，都很坏：

1. 她以为自己讲过；
2. 或者把那句机器口吻当成"用户命令的输出"，从而误判自己做过什么、做到哪。

## 需求

- [ ] 回执的归属必须是**第三方**（执行端），不是她、也不是用户
- [ ] 渲染层不能再写「不是 user 就当成她」
- [ ] 正文第一行就要能看出「这是回执」，即使某处渲染标错也不会被误读
- [ ] 她的口吻**只保留在 QQ 推送**（那时真的是她在对用户说话）

## 设计决策

### 1. 新增 `engine` 角色 + 共享渲染函数

`packages/core/src/memory/render-dialogue.ts`：

```
dialogueSpeaker(role, labels?)  →  user: '你' | assistant: '昔涟' | engine: '工程端'
```

**所有**渲染器必须用它（不要各自再写一遍三元表达式）。

### 2. 未知 role 仍当作她

历史数据里只有 `user` / `assistant`。加新角色时**不能**让老数据渲染成"工程端"或"用户" ——
兼容规则写在函数里并有单测。

### 3. 正文自带来源前缀

`【工程回执·来自 dsh 执行端】项目 … 第 N 轮已结束：…`

**双保险**：即使某个未来渲染器把角色认错，文字本身也标明了来源。

### 4. 记忆回执**不再**借用她的口吻

`return-project-task-result` 当初为了"别太干"让 `composeProjectTaskNotice()` 生成她的话塞进回执。
那个决定建立在"这条是她说的"这个**错误前提**上 —— 前提没了，做法就要收回：

- **记忆回执**：事实 + 归属（`engine`）
- **QQ 推送**：她的口吻（不变，那才是她说话）

### 5. 不做的

- 不迁移历史回执（它们都在 `synthetic='project-task-result'` 下，且 `skip_profile`，
  影响面只有"她最近会看到自己说过一句机器口吻的话"；改历史会动了不可变事件的原则）

## 对账方向确认

- [x] 改 core 渲染路径 ⇒ 影响所有对话注入（不止委托任务），所以要**全仓回归**
- [x] 不新增端点、不改状态机
- [x] `role: 'engine'` 是新取值 ⇒ 下游若有按 role 分支的地方都要检查（已 grep 全部三处 + 单测）
