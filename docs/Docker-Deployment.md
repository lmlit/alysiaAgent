# 服务端版本更新 SOP

> 最后更新: 2026-08-04

## 前置条件（一次性配置）

```bash
# 1. 配好 SSH 免密登录（只需做一次）
ssh-copy-id <USER>@<SERVER_IP>
# 密码: 联系管理员

# 2. 验证免密生效
ssh <USER>@<SERVER_IP> "echo ok"
```

## 架构

```
本地 Windows (开发机)              远端 Linux (<SERVER_IP>)
┌──────────────────────┐           ┌──────────────────────┐
│ 改代码 → 构建镜像     │  scp     │ docker load → up -d  │
│ docker compose build  │ ──────→ │ 6186→6185            │
│ docker save → .tar    │         │ data 持久化到 ./data   │
└──────────────────────┘           └──────────────────────┘
```

- **本地 Bot**: AppID `<LOCAL_APP_ID>`（开发调试用，不部署）
- **云端 Bot**: AppID `<CLOUD_APP_ID>`（服务器 24h 运行）
- 两个 AppID 互不干扰

## 更新流程（每次发版按这个走）

### Step 1: 确保代码通过

```bash
cd alysiaAgent
pnpm install
pnpm --filter @alysia/core build
pnpm --filter @alysia/core test -- --exclude='tests/memory/e2e/*'
```

### Step 2: 构建镜像

```bash
cd packages/server
docker compose build
```

### Step 3: 导出 + 上传

```bash
cd packages/server

# 打包镜像（~124MB）
docker save server-alysia:latest -o alysia-image.tar

# 打包配置（★ 不含 .env！bot 凭据以服务器 ~/alysia/.env 为准，本地 .env 覆盖会导致 bot id 漂移）
tar czf alysia-deploy.tar.gz compose.yml config.yml

# 上传
scp alysia-image.tar alysia-deploy.tar.gz <USER>@<SERVER_IP>:~/
```

### Step 4: 服务器部署

```bash
ssh <USER>@<SERVER_IP>

# 加载镜像 + 解压配置 + 重启
echo '<SUDO_PASSWORD>' | sudo -S docker load -i ~/alysia-image.tar
mkdir -p ~/alysia && tar xzf ~/alysia-deploy.tar.gz -C ~/alysia
echo '<SUDO_PASSWORD>' | sudo -S docker compose -f ~/alysia/compose.yml down
echo '<SUDO_PASSWORD>' | sudo -S docker compose -f ~/alysia/compose.yml up -d

# 验证（注意宿主机端口是 6186）
curl http://localhost:6186/api/health
# → {"status":"ok","uptime":...}

sudo docker logs alysia-server --tail 20
# 看到 QQ Official READY 即正常
```

### Step 5: 提交代码

```powershell
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
git add -A; git commit -m "release: xxx"; git push
git config --global --unset http.proxy
git config --global --unset https.proxy
```

## 一键部署（Step 3+4 合并，适合小更新）

如果镜像已构建好，以下命令一键上传+部署：

```bash
cd alysiaAgent/packages/server
# 注意：alysia-deploy.tar.gz 打包时不含 .env（见 Step 3）
scp alysia-image.tar alysia-deploy.tar.gz <USER>@<SERVER_IP>:~/ && \
ssh <USER>@<SERVER_IP> "
echo '<SUDO_PASSWORD>' | sudo -S docker load -i ~/alysia-image.tar && \
mkdir -p ~/alysia && tar xzf ~/alysia-deploy.tar.gz -C ~/alysia && \
echo '<SUDO_PASSWORD>' | sudo -S docker compose -f ~/alysia/compose.yml down && \
echo '<SUDO_PASSWORD>' | sudo -S docker compose -f ~/alysia/compose.yml up -d && \
sleep 3 && curl -s http://localhost:6186/api/health && \
echo '' && sudo docker logs alysia-server --tail 10
"
```

## 回滚

```bash
ssh <USER>@<SERVER_IP>

# 查看已有镜像
sudo docker images server-alysia

# 用旧镜像启动（假设旧镜像 tag 还在）
sudo docker tag server-alysia:<old> server-alysia:latest
echo '<SUDO_PASSWORD>' | sudo -S docker compose -f ~/alysia/compose.yml up -d
```

## 服务器 compose.yml

```yaml
services:
  alysia:
    image: server-alysia:latest
    container_name: alysia-server
    restart: always
    ports:
      - '6186:6185'            # 宿主机 6186 → 容器 6185
    environment:
      - TZ=Asia/Shanghai
      - ALYSIA_CONFIG=/app/config.yml
      # ★ 新增透传：QQ 官方 Agent 凭据（config.yml ${QQ_APP_ID}/${QQ_APP_SECRET} 插值需要；
      #   缺失会导致 token 获取失败。值以服务器 ~/alysia/.env 为准，部署时不要改动 bot id）
      - QQ_APP_ID=${QQ_APP_ID}
      - QQ_APP_SECRET=${QQ_APP_SECRET}
      # ★ 8-08：ownerId 透传——openid 与 appid 绑定，缺失会导致主动消息 500/11255
      - QQ_OWNER_ID=${QQ_OWNER_ID}
      - OPENAI_BASE_URL=https://api.deepseek.com/v1
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - CHAT_MODEL=deepseek-v4-flash
      - EMBED_BASE_URL=https://open.bigmodel.cn/api/paas/v4
      - EMBED_API_KEY=${EMBED_API_KEY}
      - EMBED_MODEL=embedding-2
    volumes:
      - ./data:/app/data        # 数据库、日志、LanceDB 持久化
      - ./config.yml:/app/config.yml:ro
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'
```

## 日常运维

```bash
# 查看日志
ssh <USER>@<SERVER_IP> "sudo docker logs alysia-server --tail 50 -f"

# 重启
ssh <USER>@<SERVER_IP> "echo '<SUDO_PASSWORD>' | sudo -S docker compose -f ~/alysia/compose.yml restart"

# 查看状态
ssh <USER>@<SERVER_IP> "sudo docker ps"

# 确认版本
curl http://<SERVER_IP>:6186/api/health
```

## 技术栈

| 项目 | 值 |
|------|-----|
| Node | 22-alpine |
| pnpm | 9.x（`package.json` → `packageManager` 字段控制） |
| lockfile | v9 格式，`--frozen-lockfile` |
| better-sqlite3 | Alpine 源码编译（需 `python3 make g++`） |
| ESM `.js` 扩展名 | tsc 输出后内联 node 脚本自动补 |
| LanceDB | musl 预编译二进制，无需额外依赖 |

## 常见问题

| 症状 | 原因 | 解决 |
|------|------|------|
| QQ 发了消息没反应 | 两个实例同一 AppID 互踢 | 确认云端用 `<CLOUD_APP_ID>`，本地用 `<LOCAL_APP_ID>` |
| `lockfileVersion mismatch` | pnpm 版本不对 | `packageManager` 字段锁定 pnpm@9 |
| Docker 拉不动基础镜像 | 国内网络 | `daemon.json` → `registry-mirrors: ["https://docker.1ms.run"]` |
| `permission denied` Docker | 非 root 用户 | 用 `sudo` 或用 `sudo -S` 管道传密码 |
| 容器里 config.yml `${VAR}` 为空 | 环境变量未传入 | compose `environment:` 传入所有变量 |
| curl healthcheck 返回 404 | 端口写错了 | 宿主机端口是 `6186`，不是 `6185` |
