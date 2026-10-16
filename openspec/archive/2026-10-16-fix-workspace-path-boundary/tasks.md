# Tasks: fix-workspace-path-boundary

> 单一项的小 change（同一函数两处绕过）。实现已完成并验证，本文件据实结算。

## 实现任务

- [x] 先写复现测试（TDD 红）：`packages/core/tests/tools/filesystem.test.ts`（**新建**）
- [x] 复现确认**红** —— **三条**，且两条是**真·越界写入**（原文）：
      ```
      × ★★ 主症：`../ws-evil/…` 必须被拒（兄弟目录不是"在工作区里"）
        AssertionError: 同前缀目录被当成了工作区内路径:
          expected '✅ File written: ../ws-evil/evil.txt (…' to match /❌/
      × ★★ 主症：读工具同样拒绝同前缀目录
        AssertionError: expected 'peek' to match /❌/
      × ★★ 主症：父目录是 junction → 新建文件不得写到工作区外
        AssertionError: 沿着父目录软链写出去了:
          expected '✅ File written: link/pwned.txt (1 byt…' to match /❌/
      3 failed | 6 passed (9)
      ```
- [x] 新增 `isInside(base, target)`：**按路径段**比较（`===` 或 `base + sep` 前缀），
      含 Windows 大小写归一化
- [x] 新增 `nearestExisting(target)`：向上找**最近的已存在祖先**
- [x] `safePath()` 重写：① 路径段穿越检查 ② `base` 的 realpath ③ **待创建路径查最近祖先**
      ④ 已存在目标另外查自己
- [x] 未动 `shell_exec`（见 proposal D3）

## 测试

- [x] P1 写：`../ws-evil/evil.txt` → `❌` 且文件不存在
- [x] P2 读：`../ws-evil/peek.txt` → `❌`
- [x] P3 写：`link/pwned.txt`（junction 父目录）→ `❌` 且工作区外无该文件
- [x] P4 写：覆盖经 junction 的**已存在**文件 → `❌` 且外部内容不变
- [x] P5 回归：真正的 `../outside/escape.txt` → `❌`
- [x] P6 回归：读路径软链检查（本来就挡住）
- [x] P7 回归：工作区内写/读/建子目录照常 `✅`
- [x] P8 边界：`path: '.'` → **不报** traversal

## Apply 任务

- [x] A.1 合并到 `openspec/specs/alysia-architecture/spec.md` **新增 §6.2.1**
- [x] A.2 更新 `openspec/specs/index.md`（alysia-architecture 行「最后变更」）
- [x] A.3 运行测试（命令与结果见下）
- [x] A.4 归档
- [x] A.5 记录部署状态

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| filesystem 定向 | `run tests/tools/filesystem.test.ts`（`packages/core`） | **9 passed**（新建文件，本 change +9） |
| core 全套 | `run --exclude='tests/memory/e2e/*'`（`packages/core`） | **74 files / 725 passed**（本 change 前 716） |
| server | `npx vitest run`（`packages/server`） | 13 files / 227 passed |
| dsh-adapter | `npx vitest run`（`packages/dsh-adapter`） | 6 files / 102 passed |
| 类型 | `npx tsc --noEmit`（`packages/core`） | exit 0 |

**行为变更披露**：此前**能**通过 `../<同前缀兄弟目录>/…` 与 `…/<软链父目录>/…`
写到工作区外的调用，现在都会被拒（返回 `❌`）。
若某个既有脚本依赖这两种写法，它会开始失败 —— **那正是本 change 的目的**；
但**排查时要认准**：报错文案是 `Path traversal blocked` / `Symlink traversal blocked`。

## 部署状态

**未部署。** 只改代码与契约；未构建镜像、未重启服务、未碰线上数据。

⚠️ **可达性提醒**（写入契约与 proposal）：这组工具在生产**当前不可达**
（`packages/server/config.yml` 的 `codeMode: false`；唯一打开它的 Electron 壳已砍）。
所以本 change 是**潜在风险的提前处置**，不是线上事故的修复。
