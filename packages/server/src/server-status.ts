/**
 * **服务/宿主健康快照**（只读）—— `check_server_status` 的数据源（★ 2026-10-19，
 * change: `let-her-query-what-she-made`）。
 *
 * ## 为什么需要
 *
 * 用户问过：「他会自己触发看看卡住的进度吗」。答案是**不会自动** —— 但**被问到时**
 * 她必须能一眼看全，而不是去翻日志。这个快照就是那一"眼"。
 *
 * ## 只读边界
 *
 * 只读进程 uptime、进程内缓存、日志文件**尾部**。**不重启、不清理、不改任何东西**；
 * 日志行截断到 160 字，且**不含**任何配置值（避免把密钥/地址带进对话）。
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostPagesCache } from './host-pages.js';

export interface ServerStatusSnapshot {
  uptimeSec: number;
  /** 宿主 runner 最近一次推清单的时间（心跳的唯一可靠来源，见 host-pages.ts） */
  hostPagesReceivedAt?: string;
  pagesCount: number;
  logTail: Array<{ level: string; at: string; message: string }>;
}

/** 由 `logDir` 提供者注入（webui 模块启动时设置一次）；缺省则不读日志 */
let logDir: string | null = null;
let logFile: string | null = null;

/**
 * 记录日志目录，并**在第一次调用时**解析出"今天的日志文件"。
 * 为什么不按天拼文件名：日志模块的实现细节不该在第二个文件里复制一份。
 */
export function setServerStatusLogDir(dir: string): void {
  logDir = dir;
  logFile = null;
}

/** 找最新的一个 `*.log`（日志模块按天切；文件名不假设格式） */
function newestLogFile(): string | null {
  if (logFile) return logFile;
  if (!logDir) return null;
  try {
    const files = readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({ f, m: statSync(join(logDir as string, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    logFile = files.length > 0 ? join(logDir, files[0].f) : null;
    return logFile;
  } catch {
    return null;
  }
}

/** 读文件尾部（最多 256KB）—— 日志可能很大，**不许**整个读进内存 */
function readTail(path: string, maxBytes = 256 * 1024): string {
  try {
    const st = statSync(path);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 取一条快照。
 *
 * ⚠️ 任何一步失败都不抛 —— 看板宁可少一段，也不能因为读日志失败而让她没法回答。
 */
export function getServerStatusSnapshot(): ServerStatusSnapshot {
  const idx = hostPagesCache.get();
  const snap: ServerStatusSnapshot = {
    uptimeSec: Math.round(process.uptime()),
    pagesCount: idx?.pages.length ?? 0,
    logTail: [],
  };
  if (idx?.receivedAt) snap.hostPagesReceivedAt = idx.receivedAt;

  const file = newestLogFile();
  if (file) {
    const raw = readTail(file);
    if (raw) {
      const lines = raw.split('\n');
      const picked: Array<{ level: string; at: string; message: string }> = [];
      // 从尾部往前扫，取最近几条 WARN/ERROR（顺序最后反转回来）
      for (let i = lines.length - 1; i >= 0 && picked.length < 8; i--) {
        const line = lines[i];
        const m = /^\[([^\]]+)\]\s+\[(WARN|ERROR)\]\s+(.*)$/.exec(line.trim());
        if (!m) continue;
        picked.push({
          at: m[1],
          level: m[2],
          // 截断：不把整段堆栈/长正文带进对话
          message: m[3].slice(0, 160),
        });
      }
      snap.logTail = picked.reverse();
    }
  }
  return snap;
}
