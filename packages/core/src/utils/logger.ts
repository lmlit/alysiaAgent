// Structured logger — lightweight, zero dependencies.
// Provides debug/info/warn/error with ISO timestamps.
// Optional file persistence: configure({ logDir }) → 控制台 + 文件双写，按天滚动。

import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

let logDir: string | null = null;

function ts(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** 当日日志文件路径（logDir 未配置时返回 null） */
function todayLogPath(): string | null {
  if (!logDir) return null;
  const day = new Date().toISOString().slice(0, 10);
  return join(logDir, `alysia-${day}.log`);
}

/** 追加写文件；失败不抛（文件写坏不影响控制台） */
function writeFileLine(line: string): void {
  const path = todayLogPath();
  if (!path) return;
  try {
    appendFileSync(path, line + '\n');
  } catch { /* file write failure is non-fatal */ }
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
  } catch { /* cleanup failure is non-fatal */ }
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
    } catch { /* dir creation failure is non-fatal */ }
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
