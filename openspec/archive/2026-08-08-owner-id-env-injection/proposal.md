# Change Proposal: owner-id-env-injection

## 元信息

- **日期**: 2026-08-08
- **类型**: FIX（线上故障修复）
- **状态**: applied（实现与部署已完成，本 change 补记）
- **影响 spec**: server-hardening（§5 运行时可靠性）

## 动机（为什么做）

8-08 线上故障：12:30 午安问候连续 3 次失败（HTTP 500 / code 11255 invalid request），
用户反馈"没有触发中午好"。

**根因**（云端日志 + 数据库取证）：
- openid 与 QQ AppID **绑定**。8-08 早 .env 覆盖事故修复后云端 bot 从本地套
  （<LOCAL_APP_ID>）切回云端套（<CLOUD_APP_ID>），但 config.yml 的 `ownerId` 仍是
  **本地 bot 维度**的 openid（<LOCAL_BOT_OPENID_PREFIX>）→ 云端维度下无效 → 主动消息被 QQ API 拒绝
- 佐证：`proactive-state.json` 显示 9:00 早安成功（旧容器/本地 bot 维度）vs 12:30 失败
  （新容器/云端 bot 维度）；conversations 表 sessionId 确认用户真实 openid

**顺带发现**：容器恒 unhealthy（FailingStreak 1238）——healthcheck 用 `localhost`，
alpine busybox 解析为 IPv6 `::1`，而服务只监听 IPv4 `0.0.0.0` → 永远 refused（WebUI 实际正常）。

## 需求（做了什么）

- [x] config.yml `ownerId` 模板化 → `${QQ_OWNER_ID}`（与 appid/secret 同机制，部署不漂移）；
      本地 .env 配本地 bot 维度 openid，服务器 .env 配云端 bot 维度 openid
- [x] compose.yml environment 新增 `QQ_OWNER_ID=${QQ_OWNER_ID}` 透传
      （缺失 → 插值空串 → ProactiveService/LifeService 静默不启动——本次排查中踩到）
- [x] compose.yml healthcheck `localhost` → `127.0.0.1`（IPv6 解析坑）
- [x] 服务器：config.yml/.env/compose.yml 三处更新 + 容器重建
- [x] .env.example / config.example.yml / DEPLOYMENT.md / Docker-Deployment.md 同步说明

## 验证（已实测通过）

- 容器重建后 `Proactive send → 01E8E4C4...: OK`，21:30 晚安补发成功（用户收到）
- `docker ps` → `Up ... (healthy)`（healthcheck 修复生效）
- 教训记录：换 QQ 应用后必须同步更新 ownerId（openid 与 appid 绑定）

## 对账方向确认

- [x] 无 spec 冲突——server-hardening §5 追加两条（ownerId 凭据化 / healthcheck IPv4）
