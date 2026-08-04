# 服务端版本更新 SOP

> 最后更新: 2026-08-04

## 架构

```
本地 Windows (开发机)              远端 Linux (服务器 121.41.111.120)
┌──────────────────────┐           ┌──────────────────────┐
│ 改代码 → 构建镜像     │  scp     │ docker load → up -d  │
│ docker compose build  │ ──────→ │ 6186:6185            │
│ docker save → .tar    │         │                      │
└──────────────────────┘           └──────────────────────┘
```

- **本地 AppID**: `1905284279`（开发调试，不部署）
- **云端 AppID**: `1905266603`（服务器运行）
- 两个 AppID 互不干扰，避免同 AppID 双连接互踢

---

## 更新流程（每次发版按这个走）

### Step 1: 确保代码通过

```bash
cd alysiaAgent
pnpm install              # 依赖对齐
pnpm --filter @alysia/core build   # 编译
pnpm --filter @alysia/core test    # 跑测试（排除 E2E: -- --exclude='tests/memory/e2e/*'）
```

### Step 2: 构建 Docker 镜像

```bash
cd packages/server
docker compose build
```

当前镜像技术栈：
| 项目 | 值 |
|------|-----|
| Node | 22-alpine |
| pnpm | 9.x（package.json `packageManager` 字段控制） |
| lockfile | v9 格式，`--frozen-lockfile` |
| better-sqlite3 | Alpine 源码编译（`apk add python3 make g++`） |
| ESM `.js` 扩展名 | tsc → 内联 node 脚本自动补 |
| LanceDB | musl 预编译二进制，无需额外依赖 |

### Step 3: 导出镜像 + 部署文件

```bash
# 打包镜像
docker save server-alysia:latest -o alysia-image.tar

# 打包配置文件（compose + config + .env）
tar czf alysia-deploy.tar.gz compose.yml config.yml ../../.env

# 上传到服务器
scp alysia-image.tar alysia-deploy.tar.gz root@121.41.111.120:~/
```

### Step 4: 服务器加载并启动

```bash
ssh root@121.41.111.120

# 加载新镜像
docker load -i ~/alysia-image.tar

# 解压配置
mkdir -p ~/alysia && tar xzf ~/alysia-deploy.tar.gz -C ~/alysia

# 停旧容器 → 启动新容器
docker compose -f ~/alysia/compose.yml down
docker compose -f ~/alysia/compose.yml up -d

# 验证
curl http://localhost:6185/api/health
docker logs alysia-server --tail 30
```

### Step 5: 提交代码

```bash
# 本地推送（需 Clash 代理）
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
git add -A && git commit -m "release: 服务端更新 xxx"
git push
git config --global --unset http.proxy
git config --global --unset https.proxy
```

---

## 服务器 compose.yml（直接使用镜像，不从源码构建）

服务器上的 `~/alysia/compose.yml`:

```yaml
services:
  alysia:
    image: server-alysia:latest
    container_name: alysia-server
    restart: always
    ports:
      - '6186:6185'
    environment:
      - TZ=Asia/Shanghai
      - ALYSIA_CONFIG=/app/config.yml
      - OPENAI_BASE_URL=https://api.deepseek.com/v1
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - CHAT_MODEL=deepseek-v4-flash
      - EMBED_BASE_URL=https://open.bigmodel.cn/api/paas/v4
      - EMBED_API_KEY=${EMBED_API_KEY}
      - EMBED_MODEL=embedding-2
    volumes:
      - ./data:/app/data
      - ./config.yml:/app/config.yml:ro
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'
```

> `6186:6185` — 容器内 6185，映射到宿主机 6186（避免和本地 dev 占用的 6185 冲突）。

---

## 日常运维

```bash
# 查看日志
docker logs alysia-server --tail 50 -f

# 重启
docker compose -f ~/alysia/compose.yml restart

# 停止
docker compose -f ~/alysia/compose.yml down

# 进入容器调试
docker exec -it alysia-server sh
```

---

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `ERR_PNPM_IGNORED_BUILDS` | pnpm 版本太新 | 已用 pnpm@9，不受影响 |
| `lockfileVersion mismatch` | pnpm 版本不匹配 | `package.json` 的 `packageManager` 字段锁定版本 |
| Docker 拉不动镜像 | 国内网络 | 配置镜像加速: `daemon.json` → `registry-mirrors: ["https://docker.1ms.run"]` |
| better-sqlite3 编译失败 | Alpine 缺编译工具 | Dockerfile 已有 `apk add python3 make g++` |
| ESM import 缺 `.js` | tsc 不补扩展名 | Dockerfile 内联脚本自动修 |
| config.yml `${VAR}` 为空 | 容器内无环境变量 | compose `environment:` 传入所有需要的变量 |
| 同 AppID 互踢 | 两个实例用同一个 Bot | 本地和云端用不同 AppID |
| 启动后 QQ 连不上 | 本地 dev 进程占端口 | `docker compose down` 停旧容器 |
