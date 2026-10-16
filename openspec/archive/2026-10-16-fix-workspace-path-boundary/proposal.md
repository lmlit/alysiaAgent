# Change Proposal: fix-workspace-path-boundary

## 元信息

- **日期**: 2026-10-16
- **类型**: FIX（安全边界；两处绕过）
- **状态**: **archived**（2026-10-16 完成 propose → apply → archive；未部署）
- **影响 spec**: `alysia-architecture` **新增 §6.2.1 工作区边界契约**
- **来源**: 修复计划「第三批」的「文件工具边界」项

## 这条要解决什么

`packages/core/src/tools/filesystem.ts` 的 `safePath()` 有**两处绕过**，
**都实测可把文件写到工作区外**：

### ① 同前缀目录绕过（字符串前缀 ≠ 路径段）

```ts
if (!resolved.startsWith(resolve(base)))   // ← 字符串前缀
```

`/work/ws-evil/evil.txt` **确实以** `/work/ws` 开头，但它**不在** ws 里。

实测（旧代码）：`write_file({ path: '../ws-evil/evil.txt' })`
→ `✅ File written: ../ws-evil/evil.txt`（真的写进了兄弟目录）
读工具同理（`../ws-evil/peek.txt` → 返回了 `peek`）。

### ② 创建目标时父目录软链不检查

```ts
if (existsSync(resolved)) { /* realpath 检查 */ }   // ← 只有"已存在"才查
// 文件不存在 → 直接 return resolved
```

**待创建的文件当然不存在** ⇒ 从不检查。若父目录是软链 / junction，
写入会**沿着软链落到工作区外**。

实测（旧代码）：工作区内建 junction `link → /work/outside`，
`write_file({ path: 'link/pwned.txt' })`
→ `✅ File written: link/pwned.txt`，而文件**实际出现在 `/work/outside/`**。

> 读路径**不受**这一条影响：文件已存在 → 走 realpath 检查 → 能挡住（已加回归用例）。
> 所以这是个**只影响写入/创建**的洞 —— 而写入正是更有害的那一半。

## 需求（做什么）

- [ ] **R1**：穿越检查改为**按路径段**：`target === base || target.startsWith(base + sep)`
- [ ] **R2**：软链检查覆盖**待创建**的路径 —— 查目标**最近的已存在祖先**
- [ ] **R3**：已存在的目标仍要查**它自己**（它可能是软链）
- [ ] **R4**：`base` 自身（`resolved === base`）必须放行 —— 前缀规则最容易误伤这里
- [ ] **R5**：Windows 大小写不敏感（`realpathSync` 返回磁盘上的真实大小写，可能与入参不同）
      ⇒ 比较前归一化，避免**误报**把正常路径挡掉
- [ ] **R6**：正常用法**不受影响**（工作区内写/读/建子目录照常）

## 设计决策（怎么做，含备选与取舍）

### D1 用一个 `isInside(base, target)` 同时管两处，而不是各写各的

两处检查（穿越 / 软链）**判据本来就该一致**；旧代码里它们一个用字符串前缀、
一个用 `startsWith(realpathSync(base))` —— 同一个问题两种写法，**其中一种还是错的**。
抽成一个函数后，"按路径段"这条规则只有一个实现。

### D2 `nearestExisting()` 向上找最近的已存在祖先

对 `ws/link/pwned.txt`：目标不存在 → 向上找到 `ws/link`（存在，是 junction）
→ `realpathSync` 得到 `/work/outside` → 不在 ws 内 → **拒绝**。

**被否决：要求父目录必须存在才允许写。** 那会让 `mkdirSync(dir, {recursive:true})`
这条既有能力失效（工具本就支持一次写入多级新目录），属**功能倒退**。

### D3 不把 `shell_exec` 一起纳入本 change

计划里那句「工作目录和命令黑名单不能被当作真正的沙箱」是**结论**，不是本 change 的任务：
`shell_exec` 的边界问题是**独立且更大**的（命令黑名单天生不可能完备）。
本 change 只让**三个文件工具**的边界成立，并在契约里**写明它不是沙箱**。

## 对账方向确认

- [x] 与现有 spec 冲突？——`alysia-architecture` §6.2 只列了工具表，
      **从未声明**工作区边界的判据。本 change **新增 §6.2.1**。
- [x] 方向判断：**缺陷**（行为不对）⇒ **改 impl + 补 doc**。
- [x] 涉及 Web API？——**不涉及**。
- [x] ⚠️ **生产可达性已核实**：`packages/server/config.yml` 是 `codeMode: false`，
      `capabilities.ts` 据此不注册这组工具；唯一打开它的 Electron 壳已于 **2026-09-25** 砍掉。
      ⇒ **当前生产不可达**。但 `registerCodeTools()` 是**公开方法**，属**潜在**风险，
      故按计划**留在第三批**（计划原文的「优先级例外」条件——"如果实际启用"——**不成立**）。

## 测试计划

落点：`packages/core/tests/tools/filesystem.test.ts`（**新建**；此前这组工具**没有测试**）。

用临时目录 + **junction**（Windows 上创建 junction **不需要管理员权限**，
所以这条用例在 CI/本机都能跑）。

| 编号 | 场景 | 验收 |
|---|---|---|
| P1 | **主症**：`../ws-evil/evil.txt`（兄弟目录，同前缀） | 返回 `❌` 且**文件不存在** |
| P2 | **主症**：读工具的同类路径 | 返回 `❌`（不返回内容） |
| P3 | **主症**：`link/pwned.txt`（父目录是 junction） | 返回 `❌` 且**工作区外没有该文件** |
| P4 | 覆盖已存在的文件（经 junction） | 返回 `❌` 且外部文件内容**不变** |
| P5 | 回归：真正的 `../outside/x` | 照旧 `❌` |
| P6 | 回归：读路径的软链检查 | 照旧 `❌`（本来就挡住） |
| P7 | 回归：工作区内写/读/建子目录 | 照旧 `✅` |
| P8 | 边界：`path: '.'`（`resolved === base`） | **不得**报 traversal |

## ⚠️ 动手前的提醒

- **别把 `shell_exec` 顺手一起改**（见 D3）——那是另一个问题，混进来会让本 change 的验证失真。
- **别用「路径存在性」当放行条件**（见 D2）：创建路径天生不存在。
