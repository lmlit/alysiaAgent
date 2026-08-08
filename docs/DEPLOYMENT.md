# Alysia Agent — 部署指南（Deployment Guide）

> 本文档面向 GitHub 使用者：如何**本地部署**和**服务器部署**自己的 Alysia。
> 不含任何私有凭据——所有 AppID、服务器地址均为占位符，请替换为自己的。
> 内部团队部署 SOP 见 `docs/Docker-Deployment.md`（含私有信息，不对外）。

---

## 前置准备（一次性）

| 项 | 说明 |
|----|------|
| Node.js | 20+ |
| pnpm | 9.x（`packageManager` 字段已锁定） |
| QQ 开放平台机器人 | 在 [q.qq.com](https://q.qq.com) 注册应用 → 获取 **AppID** + **AppSecret**（必选其一：QQ 官方 / Telegram / OneBot） |
| LLM API Key | 任意 OpenAI 兼容服务：DeepSeek / OpenAI / Moonshot… |
| Embedding API Key | 智谱（embedding-2）/ OpenAI（text-embedding-3-small）——**DeepSeek 不提供嵌入** |

---

## 方案一：本地部署（开发/试用）

### 1. 克隆并安装

```bash
git clone <your-repo-url>
cd alysiaAgent
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env：填入 LLM / Embedding / QQ 凭据
```

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=<your-llm-key>
CHAT_MODEL=deepseek-v4-flash

EMBED_BASE_URL=https://open.bigmodel.cn/api/paas/v4
EMBED_API_KEY=<your-embed-key>
EMBED_MODEL=embedding-2
EMBED_DIMENSION=1024

# QQ 官方 Agent（q.qq.com 注册）
QQ_APP_ID=<your-qq-app-id>
QQ_APP_SECRET=<your-qq-app-secret>
```

### 3. 配置文件

```bash
cp config.example.yml packages/server/config.yml
```

需要修改：

- **`bot.ownerId`**：这是"你"的身份标识——QQ 官方场景下填**用户的 openid**（不是 QQ 号！），
  用于主动消息（问候/生活事件/提醒推送）定位你。openid 在 QQ 官方回调事件里
  （`user_openid` 字段），或者先启动一次，看日志里消息事件携带的 openid。
  ⚠️ **openid 与 AppID 绑定**：换了 QQ 应用后必须更新为对应维度下的 openid，
  否则主动消息报 `500 code 11255 invalid request`。推荐写法 `ownerId: "${QQ_OWNER_ID}"`，
  在 `.env` 里配置（多环境不漂移）。
- 如果只用 QQ 官方，保留 `qq_official` 段；用 OneBot（NapCat/LLOneBot）则填 `qq` 段
  并指向你的 OneBot WebSocket 端口。

### 4. 构建并启动

```bash
pnpm build
pnpm --filter @alysia/server start
# 开发模式（热重载）：
# pnpm --filter @alysia/server dev
```

### 5. 验证

- 日志出现 `✅ Bot ONLINE — READY` → QQ 连接成功
- 日志出现 `[Proactive] service started` / `[Life] service started` → 主动服务在跑
- WebUI：`http://localhost:6185/api/health` → `{"status":"ok"}`
- 给 bot 发条消息测试对话；设定时提醒测试主动推送

---

## 方案二：服务器部署（Docker）

> 适用于 24h 运行的服务器。数据（SQLite/LanceDB/日志）持久化到 `./data` 卷。

### 1. 本地构建镜像

```bash
cd packages/server
docker build -f Dockerfile -t alysia-server:latest ../..
# 或：docker compose build（若用 compose 方式）
```

### 2. 导出 + 上传到你的服务器

```bash
docker save alysia-server:latest -o alysia-image.tar
scp alysia-image.tar config.yml <your-user>@<your-server>:~/
# 注意：.env 不上传——凭据直接在服务器上维护（见下一步）
```

### 3. 服务器上准备 compose.yml 与 .env

`~/alysia/compose.yml`（通用模板，替换占位符）：

```yaml
services:
  alysia:
    image: alysia-server:latest
    container_name: alysia-server
    restart: always
    ports:
      - '6186:6185'            # 宿主机 6186 → 容器 6185（可改）
    environment:
      - TZ=Asia/Shanghai
      - ALYSIA_CONFIG=/app/config.yml
      - QQ_APP_ID=${QQ_APP_ID}          # 从同目录 .env 读取
      - QQ_APP_SECRET=${QQ_APP_SECRET}
      - OPENAI_BASE_URL=https://api.deepseek.com/v1
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - CHAT_MODEL=deepseek-v4-flash
      - EMBED_BASE_URL=https://open.bigmodel.cn/api/paas/v4
      - EMBED_API_KEY=${EMBED_API_KEY}
      - EMBED_MODEL=embedding-2
    volumes:
      - ./data:/app/data        # 数据库、日志、向量库持久化
      - ./config.yml:/app/config.yml:ro
```

`~/alysia/.env`（服务器上单独维护，**不要用本地 .env 覆盖**）：

```bash
QQ_APP_ID=<your-qq-app-id>
QQ_APP_SECRET=<your-qq-app-secret>
OPENAI_API_KEY=<your-llm-key>
EMBED_API_KEY=<your-embed-key>
```

### 4. 启动 + 验证

```bash
docker load -i alysia-image.tar
docker compose -f ~/alysia/compose.yml up -d
sleep 5
curl http://localhost:6186/api/health        # → {"status":"ok"}
docker logs alysia-server --tail 20         # 看到 ✅ Bot ONLINE — READY 即正常
```

### 5. 日常运维

```bash
docker logs alysia-server --tail 50 -f      # 看日志
docker compose -f ~/alysia/compose.yml restart   # 重启
```

---

## 常见问题

| 症状 | 原因 | 解决 |
|------|------|------|
| 日志 `Failed to get access token` | QQ 凭据缺失/错误 | 确认 `.env` 的 `QQ_APP_ID/QQ_APP_SECRET` 正确，且 compose environment 透传了这两个变量 |
| bot 收到消息不回复 | 两个实例用了同一 AppID 互踢 | 每套部署用独立的 QQ 应用 |
| 主动消息发送失败 | QQ 官方 48h 互动窗口关闭 | 用户发消息后 48h 内可主动推送；超时需用户先发消息 |
| 容器里配置项为空 | 环境变量未注入 | compose `environment:` 逐项透传 |
| 数据丢了 | 卷未挂载 | 必须挂 `./data:/app/data` |

---

## 相关文档

- `USAGE.md` — 使用手册（配置详解）
- `.env.example` — 环境变量模板（全占位符）
- `config.example.yml` — 配置模板（全占位符）
- `docs/Web-API-Design.md` — Web 端 API 契约（开发用）
