# Change Proposal: fix-migration-and-logger-silent-failure

## 元信息

- **日期**: 2026-10-02
- **类型**: FIX（静默失败；存储可观测性第一刀）
- **状态**: archived（2026-10-02 实现 + 验证完成；apply 已合并回 `memory-system` **§4.7**）
- **影响 spec**: `memory-system`（新增 §4.3 存储写入留痕契约，先落"迁移"与"日志子系统"两条）

## 动机（为什么做）

一次全量存储层审计（9 个 store / 55 个写入点）的结论：**留下可查痕迹的接近 0**。
其中最基础、后果最重的两处：

### 1. `database.ts` 有 13 处裸 `catch { /* column already exists */ }`

```ts
try {
  db.exec(`ALTER TABLE persona ADD COLUMN memory_config TEXT NOT NULL DEFAULT '…'`);
} catch { /* column already exists */ }
```

注释写的是**假设，不是验证**。于是「列已存在」（正常的幂等跳过）与
「锁库 / 磁盘满 / 权限不足」（迁移真失败）**完全混同**。后果链：

```
迁移静默失败 → 列没加上 → 进程照常启动、启动日志全绿
  → 直到某次写该列才报 no such column
  → 而读到 undefined 时又走「回落默认值」
  → 「库结构不对」长期伪装成「还没有数据」
```

**同一文件里另有一半迁移用的是更好的写法**（`PRAGMA table_info` + `if (!has(col))`：
`persona.role` / `worldbook.role` / `events.archived` / `life_templates.category` …）——
**不吞错，真失败会大声抛**。所以本 change 不是"发明新方案"，
而是**把文件里已有的正确写法统一到剩下 13 处**。

### 2. 日志子系统自身失败被吞 —— 整个可观测性的地基

```ts
// utils/logger.ts:27-33
function writeFileLine(line: string): void {
  try { appendFileSync(path, line + '\n'); }
  catch { /* file write failure is non-fatal */ }
}
```

`catch` 是**合理的**（文件写坏不该影响控制台），但**一点都不说**就致命了：
**磁盘满时，所有"有痕迹"的路径会集体变成"无痕迹"，而这个失败本身也无痕迹。**

`configure()` 的 `mkdirSync` 失败（L90）、`cleanupOldLogs()` 的失败（L47）同款。

> 这是审计里唯一一条**能一次性让所有其他日志失效**的问题，所以排在第一刀。

## 需求（做什么）

- [ ] R1 `database.ts` 抽 `addColumnIfMissing(db, table, column, ddl)`：**先探测再执行**
      —— 列已在 → 跳过（幂等）；否则执行，**失败原样抛出**（大声）
- [ ] R2 13 处裸 catch 迁到该 helper，**行为不变**（DDL 字符串、顺序逐字保留）
- [ ] R3 `logger.writeFileLine` 失败时**用 `console.error` 喊一次**（带 flag 防刷屏）；
      **不得走 logger 自己**（会递归）
- [ ] R4 `logger.configure` 的 `mkdirSync` 失败同样喊一次（失败原因：日志目录建不出来 =
      文件持久化从未生效）
- [ ] R5 `cleanupOldLogs` 的裸 catch 同样处理（清理失效会让磁盘慢慢被日志吃满）
- [ ] R6 测试：迁移幂等（重复 init 不抛）+ 真失败会抛 + logger 写失败会被喊出来
- [ ] R7 `docs/KNOWN-ISSUES.md` 登记本次**未纳入**的其余裸 catch（存储层之外的那些）

## 设计决策（怎么做，含备选与取舍）

1. **★ 不给裸 catch 加日志，而是去掉裸 catch。**
   「列已存在」不是错误，是**幂等成功**。加日志会让每次启动刷 13 行噪声，
   而探测式**根本不需要 catch** —— 真失败自然抛出，这就是"大声失败"。
   （备选：catch 里判 `err.message.includes('duplicate column')` 再决定记不记。
   否决：**靠错误文案匹配**比探测脆弱，SQLite 换版本改了措辞就静默失效。）

2. **13 处收敛到一个 helper，而不是复制 13 段 `PRAGMA + if`。**
   本项目已经在同一文件里手写了 8 处探测式；这次顺势**把写法收敛成唯一入口**，
   以后再加列只有一种写法，不会有人再写出裸 catch。

3. **helper 不做 PRAGMA 缓存。** 13 次 `PRAGMA table_info` 是进程内的微秒级开销；
   缓存要按 db 实例做键，跨测试会有脏读风险。**简单正确 > 省这点开销。**

4. **logger 自身失败用 `console.error` 直写，不用 `logger.warn`。**
   `fmt()` 内部就是 `console.log` + `writeFileLine` —— 在里面调 logger 会无限递归。
   加 `fileWriteFailed` 标志位：只在**第一次**失败时喊，避免磁盘满时把 stderr 刷爆。

5. **`catch` 本身保留（不改成抛）。** 文件写坏不该拖垮进程——这与"不吞错"不冲突：
   **不吞的是"知道"，不是"异常"**。区别在于现在它会喊。

## 对账方向确认

- [x] 是否与现有 spec 冲突？**不冲突**——`memory-system` 现有 §4.1.1/§4.1.2 讲的是
      采样槽与预算观测；存储写入留痕是**新增章节**（doc 未声明 → 补 doc）。
- [x] 涉及 Web API？**不涉及**（纯 core 内部 + 日志）。
- [x] 是否顺手改其余裸 catch（`CronProcessor` / `PromptAssembler` / `PersonaStore`）？
      **不改，登记在案**（R7）。本 change 守住"地基"这一刀，避免范围蔓延。

## 测试计划

- **单测** `packages/core/tests/memory/unit/database.test.ts`：
  - 重复 `initDatabase` 幂等（第二次不抛、列仍齐全）
  - **真失败会抛**：用一个列名冲突/只读库之类的构造，确认不再被吞
  - `addColumnIfMissing`：列已在 → 不执行 DDL（可用 spy 或建表后断言不变）
- **单测** `packages/core/tests/utils/logger.test.ts`：
  - 写文件失败 → `console.error` 被调用一次（stub `appendFileSync` 抛错）
  - 连续多次失败 → 只喊一次（防刷屏）
- **回归**：core 全量（不含 e2e）+ server 全量。
