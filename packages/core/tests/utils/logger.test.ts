// tests/utils/logger.test.ts — 日志滚动清理：保留 7 天（用户拍板：清理太频繁丢失分析信息）
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger, startDailyLogCleanup } from '../../src/utils/logger.js';

let tempDir: string | null = null;

function makeLogDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'alysia-log-test-'));
  logger.configure({ logDir: tempDir });
  return tempDir;
}

/** 写入指定日期的日志文件（模拟历史滚动日志） */
function writeLog(day: string, name = `alysia-${day}.log`): void {
  writeFileSync(join(tempDir!, name), '[2026-01-01 00:00:00] [INFO] test\n');
}

function logFiles(): string[] {
  return readdirSync(tempDir!).filter(f => f.startsWith('alysia-') && f.endsWith('.log')).sort();
}

describe('logger 日志清理（保留 7 天）', () => {
  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('startDailyLogCleanup 立即执行一次清理：超过 7 天的删除、7 天内的保留', () => {
    const dir = makeLogDir();
    const today = new Date();

    const d = (offsetDays: number) => {
      const t = new Date(today);
      t.setDate(t.getDate() - offsetDays);
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    };

    writeLog(d(0));  // 今天
    writeLog(d(6));  // 6 天前（保留：0 点距今 ≤ 6天23h < 7天）
    writeLog(d(7));  // 7 天前（删除：0 点距今 ≥ 7天，绝对时长语义）
    writeLog(d(8));  // 8 天前（删除）
    writeLog(d(30)); // 30 天前（删除）
    expect(logFiles()).toHaveLength(5);

    const timer = startDailyLogCleanup();
    expect(timer).not.toBeNull();

    const remaining = logFiles();
    expect(remaining).toContain(`alysia-${d(0)}.log`);
    expect(remaining).toContain(`alysia-${d(6)}.log`);
    expect(remaining).not.toContain(`alysia-${d(7)}.log`);
    expect(remaining).not.toContain(`alysia-${d(8)}.log`);
    expect(remaining).not.toContain(`alysia-${d(30)}.log`);
    expect(remaining).toHaveLength(2);

    if (timer) clearInterval(timer);
  });

  it('非日志文件不受影响；超期旧日志删除', () => {
    const dir = makeLogDir();
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    writeLog('2000-01-01'); // 26 年前的日志 → 删除
    writeLog('2000-01-02', 'other-named.log'); // 非 alysia- 前缀 → 保留
    expect(logFiles()).toHaveLength(1);

    const timer = startDailyLogCleanup();
    expect(logFiles()).toEqual([]); // 超期 alysia-* 日志已删
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'other-named.log']); // 其他文件不动
    if (timer) clearInterval(timer);
  });
});

// ★ 2026-10-02 change: fix-migration-and-logger-silent-failure
//
// 日志子系统自己的失败以前是**一声不吭**的裸 catch。最坏的情况：
// 磁盘满时所有"有痕迹"的路径集体变成"无痕迹"，而这个失败本身也无痕迹 ——
// 整个可观测性的地基塌了，还没人知道。
describe('logger 自身失败必须喊出来', () => {
  let badRoot: string | null = null;

  afterAll(() => {
    // 恢复：一次成功的写入会把"已喊过"的标志位重置，避免影响别的用例
    const good = mkdtempSync(join(tmpdir(), 'alysia-log-restore-'));
    logger.configure({ logDir: good });
    logger.info('restore');
    rmSync(good, { recursive: true, force: true });
    if (badRoot) rmSync(badRoot, { recursive: true, force: true });
  });

  it('日志目录建不出来 → console.error 喊一次（且不刷屏）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    badRoot = mkdtempSync(join(tmpdir(), 'alysia-log-bad-'));
    // 拿一个「文件」当目录用 → mkdirSync 必然失败
    const notADir = join(badRoot, 'not-a-dir');
    writeFileSync(notADir, 'x');

    logger.configure({ logDir: notADir });  // ← 第 1 次喊
    logger.info('a');                        // 写文件也失败，但不应再喊
    logger.info('b');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('日志目录创建失败');

    spy.mockRestore();
  });
});
