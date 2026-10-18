# Change Proposal: let-her-query-what-she-made

> 模板：复制到 `openspec/changes/<change-name>/proposal.md` 使用。
> 开发纪律见 `openspec/project.md`：任何行为变更必走 propose → apply → archive。

## 元信息

- **日期**: 2026-10-19
- **类型**: NEW（只读能力）+ FIX（用"再造一次"回答"在哪"）
- **状态**: proposed → in_progress → applied → archived
- **影响 spec**: `project-tasks`（§17 新增契约 68h；§11 契约 38d 的清单有了消费者）

## 动机（为什么做）

**用户原话**：「看服务器的记录，她获取网址的方法**只有新建一个**，这不对吧，有些是我已经做过的；
dsh 插件不止可以用来生成东西，还可以帮她扩展、已经操作我们的服务器」。

**记录为证**：任务表里有一条

```
2026-10-18T15:53  delegated  核实 island.html（3D 海岛场景那一页）当前真实的对外可访问地址。
                            不要再凭回执转述——请自己用 curl 或浏览器实际打开验证…
```

她**为了回答"那页的网址是多少"开了一个任务** —— 那个任务会跑 dsh、花时间、花 token、
还会往工作区写东西。而她要的只是一句**查询**。

根因：能力面只有"创建/推进/续作任务"，**没有"查"**。`get_project_task` 要 taskId 才能查，
她并不知道哪个 taskId 对应 `island.html`；`/pages` 是给人看的网页，不在她的工具面里。

## 需求（做什么）

- [ ] 两个**只读**工具（聊天侧）：`list_my_pages({projectId?, limit?})`、`find_page({query})`
- [ ] 输出：标题、完整地址（已上线 `/p/…` / 预览 `/w/…`）、更新时间、哪页还没上线
- [ ] 明确写进工具说明与输出：**"要链接直接给，不要为了一个网址去新建任务"**
- [ ] 数据来源：宿主上的 `pages.json`（基站生成器每 10s 重建）→ 由宿主 runner 每轮
      `POST /api/host/pages` 推给服务端（容器看不到宿主目录）
- [ ] 没有清单 ⇒ **不注册**这两个工具；拿不到 ⇒ 如实说"读不到"，不许编
- [ ] 清单旧了 ⇒ 标出"是 N 分钟前的"，别把旧数据说成现况

## 设计决策（怎么做，含备选与取舍）

1. **查询工具放聊天侧（core tools），不放 dsh 侧**：她问"链接呢"发生在**聊天**里；
   dsh 侧的 `publish_page` 是"干活时用"，两者场景不同。两者共用同一份清单数据。
2. **数据由 runner 推，不给容器挂宿主目录**：
   - 备选（否）：compose 挂 `/srv/alysia-preview` 进容器 —— 能做到，但要改服务器 compose
     并重建容器（一次性停机），而且把宿主的展示目录暴露进容器；
   - 备选（否）：只读 `project_tasks.artifacts` —— **不完整**：10-18 之前做的页面
     （`essay-*.html` 那批）没有 artifacts，正是用户说的"有些是我已经做过的"；
   - ✅ 选：hub 写 `pages.json`（机器可读的同一份清单）→ runner 每 15s 轮询时顺手推一份。
     代价是"最多 15s + 10s 的延迟"，所以输出里必须带 `generatedAt`/`receivedAt`。
3. **`pages` 是可选 provider**：不给就不注册（沿用"能力开关 = 配置即开关"的既有语义），
   免得出一个"看起来能查、其实永远空"的工具。
4. **只读，无副作用**：不建任务、不跑 dsh、不写文件 —— 单元测试用"`createProjectTask` 直接抛错"
   来钉住这一条。

## 对账方向确认

- [x] 与契约 38d（`/pages` 是"给人看的清单"）一致：本 change 只是**再给它一个机器读者**
- [x] 涉及 Web API：新增 `POST /api/host/pages`（runner 上报）+ `GET /api/host/pages`（自查）。
      需同步 `docs/Web-API-Design.md`
- [x] 涉及她的文档（`AGENTS.md`）？**否**（工具说明里说清了；`AGENTS.md` 讲的是工作区规矩）

## 测试计划

- core 单测（12 例）：注册开关 / 列出与过滤 / 「不要为了网址建任务」的措辞 / 旧清单提示 /
  读不到时如实说 / **只读**（`createProjectTask` 抛错仍正常返回）
- 真机：`/api/host/pages` 收到 13 页；容器启动日志出现
  `[tools] 已注册页面查询工具：list_my_pages / find_page`
- 由用户在 QQ 里问一次「你都做过哪些页面」做终验（本 change 无法自证 LLM 会不会用）
