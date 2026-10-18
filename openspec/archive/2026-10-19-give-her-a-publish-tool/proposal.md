# Change Proposal: give-her-a-publish-tool

> 模板：复制到 `openspec/changes/<change-name>/proposal.md` 使用。
> 开发纪律见 `openspec/project.md`：任何行为变更必走 propose → apply → archive。

## 元信息

- **日期**: 2026-10-19
- **类型**: NEW（能力工具）+ FIX（废掉"事后没收"）
- **状态**: **archived（2026-10-19）**
- **影响 spec**: `project-tasks`（§17 契约 68c/72、§11）、`dsh-adapter`（新增工具）

## 动机（为什么做）

**用户原话**：「我们可以创建一些**越权工具**？作为白名单给他用？」

这句话点破了 2026-10-18 两次事故的根因。所谓"路径白名单"其实一直在做**事后惩罚**：
她写了不该在那个阶段写的东西 ⇒ 轮末把文件搬进 `.phases/violations/`。代价：

| 事故 | 代价 |
|---|---|
| sketch 轮她写了整页 `island.html` | 整页 + 依赖 + 63 张截图被搬走（**988 / 53 个文件**两次） |
| 我枚举式白名单漏了 `AGENTS.md`，又在轮次中间改它 | 她的工作区说明书被搬走，那一轮 dsh 起来没有 workspace instructions |
| 她按任务要求**把页面发布进 `public/`** | **整站 7 个文件被搬走，站点断了约一分钟** |

第三件事还暴露一个自相矛盾：`public/` 只在 `publish` 阶段可写，而 `allowPublish: false`
⇒ 她**永远走不到** publish 阶段 ⇒ **"发布"在这套设计里等于自我没收**。

**结论**：路径白名单不是能力边界（她本来就能 `cp` 进 `public/`，真正的边界是 dsh 的 bwrap 沙箱），
唯一有效的作用是**把她的成果弄坏**。⇒ 改成**能力白名单**：工作区随便写，
"上线"只有一条正路——**调工具**。

## 需求（做什么）

- [ ] **新增 `publish_page` 工具**（dsh-adapter，她在委托运行体里能用）：
      `{ files: string[], home?: string }` → 把工作区页面**及其相对引用的资源**复制进 `public/`，
      **自己 HTTP 验证 200**，返回可点开的地址；`home` 指定哪一页做站点首页（`public/index.html`）
- [ ] **工具即白名单**：路径必须工作区内、扩展名白名单、拒绝隐藏文件/`public/`/`.tmp`/`.phases`
- [ ] **`allowPublish` 按任务来源判**（解锁死锁）：`origin === 'self'` ⇒ 由配置决定（默认拒）；
      用户委托（`user`/`delegated`）⇒ **允许**。工具读 `ALYSIA_ALLOW_PUBLISH`，runner 从认领响应透传
- [ ] **废掉没收**：runner 不再移动任何文件；`public/**` 的改动**只记录进回执**（"这一轮动了 public/"）
- [ ] `PHASE_PROMPTS.publish` 改成"调用 `publish_page`"（不再让她去跑写死文件清单的 `publish.sh`）

## 设计决策（怎么做，含备选与取舍）

1. **工具在 adapter 里而不是 server 里**：它要读写宿主工作区，而 adapter 就住在 dsh 进程里
   （cwd = 工作区，同一用户）。server 在容器里，看不到宿主路径。
2. **不用 `publish.sh` 当正路**：那份脚本的文件清单是写死的（她又忘了加 `island.html` 的概率极高），
   而且"发布成功"的判据在她手里。工具把清单换成参数、把判据换成 HTTP 200。
3. **资产自动带上**：她写的页面几乎都引用 `style.css` / `vendor/three.min.js`；
   只发 html 会得到一个"能打开但是裸的"页面。⇒ 解析 `src`/`href` 的相对路径并一起发。
4. **`allowPublish` 按来源分**是本 change 唯一改**权限语义**的地方，理由：
   "她能不能自己决定上线"（自发起）与"用户让她上线"是两件事；当前实现用同一个开关管两件事，
   结果两边都坏（自发起能偷偷发 / 用户委托发不出去）。
   - 备选（否）：全局打开 `allowPublish` —— 那等于让自发起也能上线，是 `let-her-start-her-own-projects` 刻意守住的。
5. **不搬文件、只记账**：越界记录保留（回执里能看到"这一轮动了 public/"），但**一个文件都不动**。
   真正的越界（工作区之外）由 bwrap 负责，那才是边界。

## 对账方向确认

- [x] 与契约 68c 冲突 ⇒ **改 doc**（方向：能力边界 > 路径惩罚，本仓宪法 §6 早有此排序）
- [x] 与契约 72（能不能上线只由配置决定）**收敛**：配置只约束**自发起**；用户委托默认允许
- [x] 涉及 Web API？`GET /api/project-tasks/next` 响应**多一个字段** `allowPublish`（向后兼容）
- [x] 涉及她的文档（`AGENTS.md`）？**是** —— 发布那一节改成"调 `publish_page`"，并删掉"阶段外写入会被搬走"

## 测试计划

- adapter 纯函数：路径校验（越界/隐藏/扩展名）、资产收集（相对/绝对/外链）、`ALYSIA_ALLOW_PUBLISH=0` 拒绝
- runner：`inspectPhaseWrites` 不再移动文件（只返回清单）、`public/**` 被记为 `publish-touch`
- core：`PHASE_PROMPTS.publish` 提到 `publish_page`
- 真机：跑一次"把某页发布出去"的任务，看回执里出现 200 自证与正确地址
