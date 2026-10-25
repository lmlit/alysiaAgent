# Change Proposal: disable-publishing

## 元信息

- **日期**: 2026-10-25
- **类型**: MODIFY（关功能，不删数据）
- **状态**: applied
- **影响 spec**: `dsh-adapter` 之外的 **`project-task-delegation`** 与 `ai-life-system` 的「她做过什么」
- **来源**: 用户「**公开的先 ban 了，把功能关了，我想想怎么改**」，随后澄清
  「**就是昔涟调用工具生成网站和发博客的那个功能**」

## ★ 先分清两层（我一开始也差点搞混）

| | 是什么 | 存在哪 |
|---|---|---|
| **公开日记** | **内容**：她每天一篇第一人称日记，标 `visibility='shared'`（注释写"半公开，进博客栏目"） | `ai_life_records` |
| **博客发布** | **投递机制**：`start_project_task` 等工具 + `projects.alysia-blog` + 宿主 runner | 工具 + 配置 + runner |

用户要关的是**第二层**。所以：**日记照写**（内容还在，可用 `GET /api/life/her-records` 读），
只是**不再自动上站**。

## 需求

- [x] 新增 `features.publish?: boolean`，**默认 false**（必须显式 true 才恢复）
- [x] 关闭时同时不注册三组工具：
      · 委托（`start_project_task` / `continue_project_task` / `accept_project_task` / `get_project_task`）
      · 页面清单（`list_my_pages` / `find_page`）
      · 服务健康（`check_server_status`）
- [x] `al:selfActivity`（她自己发起项目）同样受这个开关约束
- [x] 启动日志**必须说出开关状态**（开/关各一行，关时 warn 并说明"配置与页面保留"）
- [x] **不删配置、不删数据**：`config.projects:` 保留；宿主上已有页面不动

## 关键决策

**为什么连"页面清单"和"服务健康"也一起关**：它们本身只读，但她拿到清单后会试图"再做一个"——
发布关了却留着"你做过这些页面"的线索，等于给了一半的入口。**关功能就要关干净。**

**为什么做成配置开关而不是删代码**：用户明确说"我想想怎么改"，所以这是**临时关停**，
要能一行 `features.publish: true` 恢复；删代码会让"想清楚之后"重新实现一遍。

**为什么不删 `config.projects`**：它同时是"能做哪些项目"的登记表，
删了等于把 alysia-blog 的 publicUrl/workspace/profile 一起丢掉（那些是宿主侧的真实配置）。

## 测试

- `publishing-switch.test.ts`（2 例）：缺省关闭 / **只有显式 `true` 才开**（`'true'`、`1` 都不算）
- 本地真机：启动日志 `[al:core] 页面/博客发布能力：**已关闭**`，且**没有**"已注册页面查询工具"那行
- 全量 **170 文件 / 1977 用例**

## 风险

- ⚠️ 关掉后她**不会**再发起项目任务；若之前有 in-flight 的 `project_task`，runner 仍能推进
  （我们只控制"她能不能发起/认领"，不掐已存在的任务）—— 这符合"关功能不毁数据"。
- ⚠️ 恢复只需 `features.publish: true`（config.yml 本机与服务器各自保留，注意漂移闸）。
