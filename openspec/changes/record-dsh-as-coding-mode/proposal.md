# Change Proposal: record-dsh-as-coding-mode

## 元信息

- **日期**: 2026-10-02
- **类型**: MODIFY（回传来源标记）+ DOC（定位写入 spec）
- **状态**: proposed
- **影响 spec**: `alysia-architecture`（双模式定位）、`dsh-adapter`（回传语义）
- **上游**: `bridge-memory-read`、`connect-dsh-alysia-bridge`

## 动机（为什么做）

**「编程模式」空了很久的洞，现在由 dsh 补上了。**

`CLAUDE.md` 的定位写着「聊天模式 + 编程模式，编程模式类似 Claude Code，
**携带聊天模式积累的人格/记忆**」；但 `alysia-architecture/spec.md:19` 记的是
「**砍掉 Coding/编程模式**，聚焦聊天体验」——因为自己的 Electron 壳 9-25 砍了。

现在四项都对上了：

| 原设计 | 现状 |
|---|---|
| 携带人格 | ✅ 动态人设（`GET /api/persona/prompt`，5 分钟刷新——QQ 那边的人格演化会反映过来） |
| 携带记忆 | ✅ 读通道（能召回 QQ 历史 + 画像） |
| 新积累回流 | ✅ 对话回传进**同一个**记忆库 + 会话结算 |
| 对标 Claude Code | ✅ 工具集与出厂 `standard` 一字不差 |

**两份文档现在互相矛盾**，本 change 把定位写进 spec 并修正过时的那句。

### 顺带修一个真实缺陷：回传来源标成了 `'chat'`

dsh 回传的事件用了 `source: 'chat'`，而 `EventSource` **本来就有 `'code'`**，
且 `RealtimeProcessor:41` 已经按它分流：

```ts
const mode = event.source === 'code' ? 'code' : 'chat';
await this.worldbookMatcher.match(text, mode);
```

后果：**在 dsh 里干活的对话，按"闲聊"的世界书 scope 匹配**——
`scope: 'chat'` 的条目会误触发，`scope: 'code'` 的反而匹配不到。

## 需求（做什么）

- [ ] dsh 回传改用 `source: 'code'`（**已有的枚举值**，不加新值）
- [ ] spec 记录「编程模式 = dsh」并修正 `alysia-architecture` 过时的那句
- [ ] 测试：回传事件形状断言 `source === 'code'`

## 设计决策

**决策 1：用已有的 `'code'`，不新增字段或枚举值**

调研过三条路：

| 方案 | 评价 |
|---|---|
| **`source: 'code'`** | ✅ **已有枚举值 + 已有消费点**（世界书 scope 分流）。语义准确："来自编程场景" |
| 新增 `payload.origin: 'dsh'` | ❌ 标记了没消费 = 本项目对账规则警告的「声明了没接」 |
| 加 `perspective: 'coding'` | ❌ 动枚举，且 `perspective` 是「互动 vs 她的生活」轴，不是来源轴 |

**决策 2：只改标记，不新增消费规则**

现有消费点（`WorldbookMatcher` 的 scope）**恰好就是该受影响的**。
不加「跳过人格自适应」之类的新规则——**编程也是相处**，她的性格该被这段经历影响，
一刀切跳过反而违背人设自适应的设计意图。

**决策 3：`'code'` 描述的是「环境」不是「话题」**

dsh 里也可能闲聊，但那仍然发生在编程环境里——世界书按 `code` scope 匹配是对的。
用「来源环境」而非「话题分类」做判据，不会因为"她和你聊了两句生活"就切错。

## 对账方向确认

- [x] `alysia-architecture` §1.2 那句「砍掉编程模式」**已过时** → **改 doc**
      （当时的决定是对的——我们自己不做 Electron 壳了；现在是**换个载体**实现了它）
- [x] `CLAUDE.md` 的定位**本来就对**，只补一句「由 dsh 承接」
- [ ] 涉及 Web API？不涉及（`source` 是内部字段；`/api/ingest` 的校验本来就允许 `code`）

## 测试计划

- 插件：回传事件形状断言 `source === 'code'`
- server：`/api/ingest` 接受 `source: 'code'`（现有校验已覆盖，补一条显式用例）
- 回归：常规全仓 + E2E
