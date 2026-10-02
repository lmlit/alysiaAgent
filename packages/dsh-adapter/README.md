# @alysia/dsh-adapter

把昔涟接进 DeepSeek Harness（dsh）的 bundle。

## 形态

一个 **bundle**：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，
后者插入一个 `@deepseek-ai/dsh-agent-preset` 声明。

| 组成 | 由谁提供 |
|---|---|
| **人设** | dsh 自带的 `@deepseek-ai/dsh-persona`（prefix = 昔涟人设，见 `cordis.patch.yml`） |
| **工具集** | **与出厂 `standard` preset 完全一致**（bash/pwsh/fs/web/todo/skill/delegation/compaction…） |
| **记忆 + `recall_memory`** | 本包的 `src/index.ts`（`alysia-adapter` 行） |

## 命名约定（2026-10-02）

本 bundle 新增的 preset 一律三项配套，**为了后续能加「昔涟 · PTC」「昔涟 · Cordis」而不混淆**：

| 项 | 形如 | 例（本文件） |
|---|---|---|
| Loader 行 id | `preset-alysia-<模式>` | `preset-alysia-standard` |
| `config.id` | `alysia-<模式>` | `alysia-standard` |
| 显示名 | `昔涟 · <模式>` | `昔涟 · 标准` |

出厂 preset（`standard` / `ptc` / `minimal` / `cordis`）**一行未动**——
我们只 `insert` 新行，不覆盖它们。所以 roster 里「原版」与「昔涟版」并存，
可随时切回干净模式对比（这是用户 2026-10-02 拍板的方案 a）。

### ⚠️⚠️ `config.id` 是**持久化契约**，改名会打断已有会话

2026-10-02 实测事故：把 id 从 `alysia` 改成 `alysia-standard` 后，
**所有引用过旧 id 的会话全部打不开**，报：

```
unknown agent preset: alysia
```

原因是 id 会被**写进两处持久化数据**：

| 位置 | 内容 |
|---|---|
| 会话 header | `"agentPreset":"alysia"`（创建时记录） |
| 会话日志事件 | `{"type":"agent-preset/selected","data":{"agentPreset":"alysia"}}`（中途切换记录） |

**而报错不会告诉你「它被改名了」** —— 只说「不认识这个 preset」。

→ **定 id 时就想清楚**；要改就得接受已有会话全部失效（或加一个旧 id 的兼容声明）。

**显示名（`name`）随便改** —— 它不持久化，只影响 roster 显示。

*（本次事故代价：16 个会话全删。当时会话里没有实质任务，损失可控。）*

## ★ preset 是自包含清单，不是叠加层

出厂 preset（`standard` / `ptc` / `minimal` / `cordis`）**各自完整列举一遍**自己的插件。
所以「和标准模式兼容」= 我们也要把那份清单带上，然后换掉 persona。

> **踩过的坑**：第一版只声明了 `persona` + `alysia-adapter` 两行。
> 结果**选中昔涟版就等于换了个空工具箱**——bash/fs/web/todo/skill 全部消失，
> 而 dsh **不会有任何报错**（一个合法的、只是很贫瘠的 preset）。
> `tests/preset-patch.test.ts` 现在锁住了标准插件清单，防止再次漏掉。

## 派生自哪个版本

`cordis.patch.yml` 的插件清单派生自 **dsh-desktop `0.2.0-rc.2`** 的
`@deepseek-ai/dsh-web-app/presets/standard.patch.yml`。

### dsh 升级后怎么重新比对

出厂 preset 变了**我们不会自动跟**。升级 dsh 后：

1. 取新的 standard preset：
   - 源码检出：`packages/bundle/web-app/presets/standard.patch.yml`
   - 桌面端：在 `resources/app.asar` 内（shell 打不开），用仓库里
     `E:\workSpace\.asar-x\extract.cjs` 抽取 —— 见 `docs/dsh-plugin-architecture.md`
2. 与 `cordis.patch.yml` 的 `plugins` 逐条 diff（`id` 层面比对即可）
3. 把新增/改动的条目同步进来——**只用改 `plugins` 列表，人设那段不要动**

`tests/preset-patch.test.ts` 里有 `STANDARD_PLUGIN_IDS` 快照：它抓得住
**我们这侧**的意外丢失，但**抓不到 dsh 那边新增了插件**（那只能人工 diff）。

## 安装

```bash
# <dsh> 指桌面端自带的 CLI：E:\dsh\resources\runtime\cli\bin\dsh.cmd
<dsh> plugin --profile <profile> add <本包绝对路径>
```

装完 `--dump-config` 应能看到 `# == @alysia/dsh-adapter` 层。

### 已知约束

- **`desktop` profile 被 CLI 独占**（`managed exclusively by the Electron application`）：
  能装（`plugin add` 可用），但 `--dump-config` 读不了——验证只能在桌面端里做。
- **`headless` 模板不含 preset 基础设施**：`@deepseek-ai/dsh-agent-preset` 会
  `pending (waiting for service: agentPresets)`。要验 preset 得用 web 系模板。
- **旧的 `web` profile 装不了**：其 `node_modules` 由另一套 pnpm 配置创建
  （`ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`）。用
  `dsh <name> --from-default-profile web` 建个干净 profile 即可。

## 测试

```bash
npx vitest run
```

| 文件 | 守什么 |
|---|---|
| `tests/index.test.ts` | 插件注册行为（context / variable / tool / 事件）+ **不注册 persona section**（反向守卫） |
| `tests/preset-patch.test.ts` | patch 结构、人设文本两处一致、**标准插件清单覆盖**、嵌套 group 的 `isolate` 未丢、运行时零依赖 |

## 二期待做

- `recall_memory` 目前是 **stub**；真实记忆要经 alysia server 的 HTTP 接口
  （`GET /api/memory/read` **尚未实现**，见 `docs/Web-API-Design.md`）
- 人设是**静态文本**；动态人格（`memory.getActiveSystemPrompt()`）需要走
  `dsh-persona` 的 `{{变量}}` 机制 + 一个注册该变量的插件
