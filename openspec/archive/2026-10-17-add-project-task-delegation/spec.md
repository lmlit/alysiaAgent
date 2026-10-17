# Spec delta: add-project-task-delegation

> 本 change 是 **NEW + 新系统**，所以「合并」不是往某份主 spec 里插章节，而是：
> 1. **新建** `openspec/specs/project-tasks/spec.md`（整份新增，无 diff 标记）；
> 2. `openspec/specs/index.md` **新增一行**（`project-tasks`，含首条变更记录）；
> 3. `openspec/specs/alysia-architecture/spec.md` §1.2 **加一条边界 + 一段硬约束**
>    （服务端在容器里、dsh 在宿主上 ⇒ 执行方是宿主 runner）。
>
> 因此本文件不承载逐行 diff —— 内容全在上面三处。合并后必须跑
> `scripts/check-spec-diff-residue.cjs`（已跑，exit 0）。

## 另：不新增 Web API 文档之外的契约

五个端点的对外契约写在 `docs/Web-API-Design.md` §2.4.5（本 change 内已更新）。
`docs/Web-API-Design.md` 是**契约文档而非 spec**，但本仓硬约束要求
「新增/修改 core 公开方法必须同步它」——已遵守。

## 已同步的其它文档

| 文档 | 改动 |
|---|---|
| `docs/Web-API-Design.md` | 新增 §2.4.5（五个端点 + core 方法 + 授权语义 + runner 边界） |
| `config.example.yml` | 新增 `projects:` 段（注释写明「宿主侧路径 / 不配即关闭」） |
| `CLAUDE.md` | **未改**：委托任务是新增子系统，不影响既有开发约定 |
