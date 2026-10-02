// Structured logger — lightweight, zero dependencies.
// Provides debug/info/warn/error with local-time timestamps.
// Optional file persistence: configure({ logDir }) → 控制台 + 文件双写，按天滚动。

import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

let logDir: string | null = null;

/** 本地时间戳（UTC+8 / 系统时区），格式 YYYY-MM-DD HH:mm:ss */
function ts(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

/** 当日日志文件路径（logDir 未配置时返回 null）。日期使用本地时间，与日志行时间一致。 */
function todayLogPath(): string | null {
  if (!logDir) return null;
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return join(logDir, `alysia-${day}.log`);
}

/**
 * 日志子系统自身失败时的**最后出口**。
 *
 * ★ 2026-10-02（change: fix-migration-and-logger-silent-failure）
 *
 * 以前这里（以及 configure 的 mkdir、cleanupOldLogs）失败都是**一声不吭**的裸 catch。
 * 那样最坏的情况是：**磁盘满时所有"有痕迹"的路径集体变成"无痕迹"，
 * 而这个失败本身也无痕迹**——整个可观测性的地基就塌了，还没人知道。
 *
 * 注意两点：
 * 1. **不能调 `logger.warn`** —— `fmt()` 内部就是 `console.log` + `writeFileLine`，
 *    会无限递归。所以直写 `console.error`。
 * 2. **只在第一次喊**（`fileWriteFailed` 标志位）——磁盘满会持续失败，
 *    每次都喊会把 stderr 刷爆，反而淹没别的信息。
 *
 * catch 本身保留（文件写坏不该拖垮进程）：**不吞的是"知道"，不是"异常"**。
 */
let fileWriteFailed = false;

function shoutOnce(msg: string): void {
  if (fileWriteFailed) return;
  fileWriteFailed = true;
  console.error(msg);
}

/** 追加写文件；失败不抛（文件写坏不影响控制台），但**第一次失败会喊一声** */
function writeFileLine(line: string): void {
  const path = todayLogPath();
  if (!path) return;
  try {
    appendFileSync(path, line + '\n');
    fileWriteFailed = false; // 恢复后允许下次再喊（例如磁盘腾出来了又满）
  } catch (err: any) {
    shoutOnce(
      `[logger] 日志文件写入失败 —— 文件持久化已停摆，之后所有日志只剩控制台: ${path} — ${err?.message ?? err}`
    );
  }
}

/** 清理超过 7 天的滚动日志文件（启动时调用一次） */
function cleanupOldLogs(): void {
  if (!logDir) return;
  try {
    const cutoff = Date.now() - 7 * 86_400_000;
    for (const f of readdirSync(logDir)) {
      const m = f.match(/^alysia-(\d{4}-\d{2}-\d{2})\.log$/);
      if (!m) continue;
      if (new Date(m[1] + 'T00:00:00').getTime() < cutoff) {
        rmSync(join(logDir, f));
      }
    }
  } catch (err: any) {
    // 清理失效不是致命的，但会让磁盘被日志慢慢吃满 —— 静默的话没人会提前发现
    shoutOnce(`[logger] 旧日志清理失败（磁盘可能被日志逐渐占满）: ${err?.message ?? err}`);
  }
}

/** 每日定时清理（保留 7 天日志，用户拍板：清理太频繁会丢失分析信息）。
 *  configure 时已清理一次（启动），此处补长跑容器内的定期清理。
 *  logDir 未配置（测试/CLI）返回 null，不启动定时器。 */
export function startDailyLogCleanup(
  intervalMs: number = 24 * 60 * 60 * 1000,
): NodeJS.Timeout | null {
  if (!logDir) return null;
  cleanupOldLogs(); // 立即执行一次（幂等）
  return setInterval(cleanupOldLogs, intervalMs);
}

function fmt(level: string, msg: string, ...args: unknown[]): void {
  const line = `[${ts()}] [${level}] ${msg}`;
  const full = args.length > 0 ? `${line} ${args.map(a => formatArg(a)).join(' ')}` : line;
  console.log(full);
  writeFileLine(full);
}

/** 参数格式化：对象序列化，超长截断 */
function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  // ★ 8-28 修复：Error 对象 JSON.stringify 恒为 {}（message 是非枚举属性）——
  //   所有 Error 日志丢 message 的根因（"Failed to start Alysia: {}"）
  if (arg instanceof Error) return arg.message || arg.name || String(arg);
  try {
    const s = JSON.stringify(arg);
    return s && s.length > 500 ? s.slice(0, 500) + '…' : (s ?? String(arg));
  } catch {
    return String(arg);
  }
}

export const logger = {
  /** 配置日志目录（幂等；未配置时保持纯控制台输出，兼容测试/CLI） */
  configure(opts?: { logDir?: string }): void {
    if (!opts?.logDir) return;
    logDir = opts.logDir;
    try {
      mkdirSync(logDir, { recursive: true });
      cleanupOldLogs();
    } catch (err: any) {
      // ★ 日志目录建不出来 = 文件持久化从未生效 —— 这是"以后什么都查不到"的起点，必须喊
      shoutOnce(`[logger] 日志目录创建失败 —— 本次运行不写日志文件: ${logDir} — ${err?.message ?? err}`);
    }
  },

  debug(msg: string, ...args: unknown[]): void {
    if (process.env.ALYSIA_DEBUG) fmt('DEBUG', msg, ...args);
  },
  info(msg: string, ...args: unknown[]): void {
    fmt('INFO', msg, ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    fmt('WARN', msg, ...args);
  },
  error(msg: string, ...args: unknown[]): void {
    const line = `[${ts()}] [ERROR] ${msg}`;
    const full = args.length > 0 ? `${line} ${args.map(a => formatArg(a)).join(' ')}` : line;
    console.error(full);
    writeFileLine(full);
  },
};
