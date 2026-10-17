# Spec delta: harden-delegated-runtime

> 合并去向：`openspec/specs/project-tasks/spec.md`
> 1. **§6.1 新增**（执行体的运行身份与权限边界，契约 18–23）
> 2. **§8 已知限制追加三条**（出站未收窄 / 无逐次审批 / 未抓到子进程 uid）
>
> 无逐行 `+` diff —— 内容已直接写入主 spec。合并后已跑
> `scripts/check-spec-diff-residue.cjs`（exit 0）。

## 本 change **没有**改的东西（明确记下，免得后人误以为改了）

| 项 | 状态 |
|---|---|
| dsh 的沙箱策略（`workspace-write`） | 未改 —— 它本来就限制**写**到工作区；本 change 补的是**读**边界 |
| 出站网络 | **未收窄**（博客构建要拉依赖/字体）；留审计，白名单列为后续 |
| 委托运行体持有的 token | 仍是**全权** `ALYSIA_WEBUI_TOKEN`；受限令牌列为后续 |
| `/root/alysia` 的 owner/group | 未改（只动 other 位）—— 动了会断容器写记忆 |
| 容器 / 镜像 / QQ / 记忆数据 | 未动（只切了配置里的一条 `workspace` 值） |
