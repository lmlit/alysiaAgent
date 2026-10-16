# Tasks: fix-role-activation-invariant

> 单一项的小 change。实现已完成并验证，本文件据实结算。

## 实现任务

- [x] 先写复现测试（TDD 红）：`packages/core/tests/memory/unit/PersonaStore.test.ts`
      新增 describe「★ KI-22 写入侧:最多一个激活角色」
- [x] 复现确认**红**（两条，原文）：
      ```
      × ★★ 主症：upsertRole(is_active:true) 必须清掉旧的主动行（不能只置位）
        AssertionError: upsertRole 留下了双激活行 —— 读一个写两个:
          expected [ 'alysia', 'r-extra' ] to deeply equal [ 'r-extra' ]
      × ★ 同样地：把已存在的角色激活，也要清旧的主动行
        AssertionError: UPDATE 分支同样会留下双激活:
          expected [ 'alysia', 'r-extra' ] to deeply equal [ 'r-extra' ]
      2 failed | 12 passed (14)
      ```
      ★ 两条分别覆盖 **INSERT 分支**与 **UPDATE 分支**（旧写法两处都错，只是写法相同）。
- [x] `upsertRole` 整体包进 `db.transaction()`
- [x] UPDATE 分支**不再碰 `is_active`**（激活只由事务内那两行负责，避免语义分叉）
- [x] INSERT 分支一律插 `is_active = 0`
- [x] `input.is_active` 为真 → 事务内 **先清后置**（与 `setActive` 同语义）
- [x] `get()` 加 `ORDER BY id`（兜底，针对历史脏数据）
- [x] 未改 8 个写点（理由见 proposal D1：`LIMIT 1` 同样是"不确定的取舍"，不变量优于补丁）

## 测试

- [x] R1 INSERT 分支：激活行只剩新角色
- [x] R2 UPDATE 分支：同上
- [x] R3 `is_active` 不传 → 现有激活状态不变（回归：别把不激活也清了）
- [x] R4 守卫：造双激活脏数据 → `get()` 5 次返回同一角色（已注明**旧代码也可能通过**）
- [x] R5 回归：既有 `upsertRole` / `setActive` / `listAll` / `get()` 用例继续通过

## Apply 任务

- [x] A.1 合并到 `openspec/specs/role-system/spec.md` §2.3（把不变量与"为什么在写入侧"写清）
- [x] A.2 更新 `openspec/specs/index.md`（role-system 行「最后变更」）
- [x] A.3 运行测试（命令与结果见下）
- [x] A.4 归档
- [x] A.5 记录部署状态

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| PersonaStore 定向 | `run tests/memory/unit/PersonaStore.test.ts`（`packages/core`） | **14 passed**（本 change 前 10，+4） |
| core 全套 | `run --exclude='tests/memory/e2e/*'`（`packages/core`） | **73 files / 716 passed**（本 change 前 712，+4） |
| 类型 | `npx tsc --noEmit`（`packages/core`） | exit 0 |

**行为变更披露**：

1. 激活新角色时**会清掉旧主动行**（此前不会）。
   ⇒ 若某个调用方**依赖**「`upsertRole(is_active:true)` 之后两个角色都还是 active」，
   那个依赖现在失效；但它是**缺陷性依赖**（`get()` 只能返回一个，
   `is_active=1` 本就是单行不变量），且会造成「改 A 读 B」的漂移。
2. `get()` 在**历史脏数据**（双激活）下改为**确定**取 id 最小者 —— 此前是"不确定的哪一行"。

## 部署状态

**未部署。** 只改代码与契约；未构建镜像、未重启服务、未碰线上数据。
