# Tasks: server-bind-host

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] `packages/server/src/net.ts`（新）：`isLoopbackHost` / `resolveBindHost` / `needsAuth` 纯函数
      —— 独立模块而非塞进 bootstrap（后者 `main()` 在顶层调用，**import 即启动服务器**，无法单测）
- [x] `config.ts`：`ServerConfig.server.host?: string` + `loadConfig` 透传（留 `undefined` 时由
      bootstrap 取模式默认，保证线上不变）
- [x] `bootstrap.ts`：`resolveBindHost(config.server.host, IS_DESKTOP)` + `needsAuth(bindHost)`
- [x] 启动日志明说：绑了哪 / 前端是哪个 / 鉴权开没开 / 为什么
- [x] ★ **修对配置文件**：`packages/server/config.yml`（活的那个）加 `host: "127.0.0.1"`；
      根目录 `config.yml` 的改动**已撤回**（那是死文件，见下）
- [x] `config.example.yml` 同步注释

### 单测

- [x] `tests/net.test.ts`（15 用例）：回环各形态、前缀欺骗（`127.0.0.1.evil.com` 不算回环）、
      `resolveBindHost` 各组合、**回归断言"服务器无 host 配置仍是 0.0.0.0 + 需鉴权"**
- [x] 不变量测试：「不存在对外可达 + 免鉴权」的组合

### ★ 实现中途发现并修正的部署陷阱（自己埋的雷）

第一版把 `host: "127.0.0.1"` 写进了 `packages/server/config.yml`。**这会造成生产事故**：
部署 SOP 是 `cd packages/server && tar czf alysia-deploy.tar.gz compose.yml config.yml` ——
这个文件**会被打包传到服务器**，容器会绑回环 → `6186:6185` 端口映射失效 → **服务器失联**。

- [x] 本地覆盖改走环境变量 `ALYSIA_HOST`（写进**根目录 `.env`**）
      —— `.env` 不进部署包，且 compose 的 `environment:` 是白名单、没列它 → 容器里该变量不存在
- [x] `resolveBindHost` 支持三级优先级：`config.host` > `ALYSIA_HOST` > 模式默认
- [x] `config.yml` 去掉 `host`，改为醒目注释说明为什么不能写
- [x] **运行时兜底**：容器内绑回环 → `logger.error` 喊"端口映射会失效"
      （`existsSync('/.dockerenv')`）—— 这类错误表现是"服务在跑但访问不了"的哑谜，必须响亮
- [x] 部署 SOP 加打包前自查：`grep -n "^ *host:" config.yml` 有输出就中止
- [x] 单测补：`config.host` 被插值成空串时回落 `0.0.0.0`（模拟服务器没有 `ALYSIA_HOST`）

## 实测验收（2026-09-25）

| 项 | 结果 |
|---|---|
| 启动日志 | ✅ `监听 127.0.0.1 · 鉴权: 关（回环地址，仅本机可达）` |
| `netstat` | ✅ **只有 `127.0.0.1:6185`**，无 `0.0.0.0`（局域网够不着） |
| 页面免 token | ✅ `/` `/life` `/dashboard` `/personality` 全 200 |
| API 免 token | ✅ `/api/{life,persona,profile,sessions,stats,health}` 全 200 |
| 数据正确 | ✅ 返回她的真实生活快照 |

## ★ 顺带发现的两件事（原不在计划内）

1. **有两个 `config.yml`，根目录那个是死的**
   - 服务从 `packages/server` 启动 → 读 `cwd/config.yml` = `packages/server/config.yml`（**活的**）
   - 根目录 `config.yml` 少了 `webuiToken` 那行，且若从根启动，`.env` 路径
     `cwd/../../.env` 会指向 `E:\workSpace\.env`（不存在）→ 本就跑不起来
   - 我第一版把 `host` 写进了根目录，**实测没生效**才发现。已撤回根目录改动
   - ⚠️ 这是个易踩的坑（改错文件毫无提示），已记入 HANDOFF

2. **`/api/life` 的亲密度是浮点**：实测 `44.699999999999996`
   - `/life` 页用 `CountUp`（内部 `Math.round`）侥幸正常，但 **dashboard 是直接渲染的**
     → 会显示一长串小数
   - 已在适配层收口取整（`lib/adapt.ts`，展示层要整数的地方只此一处），补 2 个单测

## Apply 任务

- [x] `openspec/specs/server-hardening/spec.md` §6：鉴权触发条件由「模式」改为「绑定地址」，
      并说明修订理由；`fail closed` 限定为「需鉴权时」；桌面模式条目改为回环规则的一个实例
- [x] `openspec/specs/alysia-console/spec.md` §7.1：补触发条件
- [x] 更新 `docs/HANDOFF.md`
- [x] 回归：641 passed（+15），全仓构建

## 未覆盖 / 遗留

- **Docker 远端未验证**：默认值（无 `host` → `0.0.0.0` + 鉴权）由单测锁定，但没实际重新部署容器
- 根目录 `config.yml` 是死文件这件事**没清理** —— 删它属于独立决定（可能有人从根启动过），
  只记在 HANDOFF 里提示
