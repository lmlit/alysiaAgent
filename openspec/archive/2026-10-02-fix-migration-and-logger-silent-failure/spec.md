# Spec 变更: fix-migration-and-logger-silent-failure

> **apply 说明**：本 change 不修改任何既有条款，只给 `memory-system` 追加一个新小节。
> 下面 `--- 以下为追加内容 ---` 之后的部分**原样追加**到
> `openspec/specs/memory-system/spec.md` 的 **§4 末尾**（即 `## 5. System Prompt 注入` 之前；
> §4 现有 4.1～4.6，故新节编号 **4.7**）。
>
> ⚠️ **本节有意不使用 `+`/`-` diff 标记**——纯新增内容用 diff 标记只会制造
> `clean-spec-diff-residue` 那类残留（本仓库已有 48 行这种债，`ai-life-system`
> 那约 42 行就是这么一次次攒出来的）。**新增即新增，不留标记。**

---

以下为追加内容
---

### 4.7 存储写入留痕契约（2026-10-02，change: fix-migration-and-logger-silent-failure）

> 起因：`life.generateEvent` 的预算观测补齐后（§4.1.2），顺带审计了**全部存储节点**
> （9 个 store / 55 个写入点）。结论：**留下可查痕迹的接近 0**。
> 本条先落**最基础的两条**——它们是"其他所有日志是否还有意义"的前提。
> 完整审计发现见 `docs/KNOWN-ISSUES.md` 的 KI-5 与 KI-11～KI-17。

**契约 1：迁移必须「探测式幂等」，不得用裸 `catch` 表达幂等。**

旧写法是：

    try { db.exec('ALTER TABLE persona ADD COLUMN x TEXT'); }
    catch { /* column already exists */ }

那句注释是**假设，不是验证**。它把两种情况压成同一个静默分支：
「列已存在」（正常的幂等跳过）与「锁库 / 磁盘满 / 权限不足」（**迁移真失败**）。后果链：

    迁移静默失败 → 列没加上 → 进程照常启动、启动日志全绿
      → 直到某次写该列才报 no such column
      → 而读到 undefined 时又走「回落默认值」
      → 「库结构不对」长期伪装成「还没有数据」

正确写法是**先探测再执行**：

    addColumnIfMissing(db, 'persona', 'x', 'ALTER TABLE persona ADD COLUMN x TEXT');

- 列已在 → 跳过（幂等）；否则执行，**失败原样抛出**（大声）。
- **禁止靠错误文案匹配**（如 `err.message.includes('duplicate column')`）：
  SQLite 换版本改了措辞就静默失效，**比裸 catch 更隐蔽**。
- **`addColumnIfMissing` 是迁移加列的唯一入口**，新增列只有这一种写法。
- 「列已存在」不是错误，是**幂等成功**——所以这里**不需要 catch**，
  也就不会再有裸 catch。

**契约 2：日志子系统自身的失败必须能喊出来。**

`utils/logger.ts` 的 `writeFileLine` / `configure`（`mkdirSync`）/ `cleanupOldLogs`
三处失败**不得静默**：

- **直写 `console.error`，不得调 `logger.*`** —— `fmt()` 内部就是
  `console.log` + `writeFileLine`，会无限递归。
- **只在第一次喊**（标志位）：磁盘满会持续失败，每次都喊会把 stderr 刷爆，
  反而淹没别的信息。
- **成功写入后复位标志位**，使故障恢复后能再次告警。

这是整条可观测性的**地基**：磁盘满时，**所有「有痕迹」的路径会集体变成「无痕迹」，
而这个失败本身也无痕迹**。

`catch` 本身保留是对的（文件写坏不该拖垮进程）：
**不吞的是「知道」，不是「异常」**——区别在于现在它会喊。

---

## 明确不涉及

- **不修其余裸 catch**（`CronProcessor:99` / `PromptAssembler:158` / `PersonaStore:33` /
  `LanceDBStore:59,96,160` / `MemoryManager:197` …）——已全部登记在
  `docs/KNOWN-ISSUES.md` KI-5，留第二刀
- **不动 `.changes` 检查**（KI-11）——口径未定（幂等跳过为 0 是正常的），要先定规则
- **不改任何行为**：DDL 字符串、迁移顺序、日志格式逐字保留
