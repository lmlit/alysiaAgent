import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReminderTool, createListRemindersTool, createCancelReminderTool } from '../../src/tools/reminder.js';

/** reminders 是模块级单例——测试间用 list+cancel 清空隔离 */
async function clearAllReminders() {
  const list = createListRemindersTool();
  const out = await list.handler({});
  if (out === 'No active reminders.') return;
  const cancel = createCancelReminderTool();
  for (const line of out.split('\n')) {
    const m = line.match(/^\[(\d+)\]/);
    if (m) await cancel.handler({ id: m[1] });
  }
}

describe('reminder tool — 8-08 可靠性修复', () => {
  beforeEach(clearAllReminders);
  afterEach(() => vi.useRealTimers());

  it('正常到点触发 notifyFn 并移除', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockResolvedValue(true);
    const set = createReminderTool(notify);
    const res = await set.handler({ time: '30min', text: '喝水' }, 'qq-official-1:private:private_abc');
    expect(res).toContain('Reminder set');
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 100);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('喝水', 'qq-official-1:private:private_abc');
    // 触发后已移除
    expect(await createListRemindersTool().handler({})).toBe('No active reminders.');
  });

  it('超长提醒（>24.8 天）被拒绝，不触发 Node setTimeout 立即执行陷阱', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockResolvedValue(true);
    const set = createReminderTool(notify);
    const res = await set.handler({ time: '600h', text: '超长提醒' });
    expect(res).toContain('Error: Reminder too far in the future');
    await vi.advanceTimersByTimeAsync(1); // 无定时器被立即触发
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifyFn 返回 false → 5min 重试一次 → 再失败丢弃', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockResolvedValue(false);
    const set = createReminderTool(notify);
    await set.handler({ time: '10min', text: '测试' });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 100); // 首次触发失败
    expect(notify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100); // 重试一次
    expect(notify).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * 60_000); // 不再重试
    expect(notify).toHaveBeenCalledTimes(2);
    // 重试失败后丢弃
    expect(await createListRemindersTool().handler({})).toBe('No active reminders.');
  });

  it('notifyFn throw → 同样走重试预算', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockRejectedValue(new Error('sendProactive 网络错误'));
    const set = createReminderTool(notify);
    await set.handler({ time: '10min', text: '测试' });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 100);
    expect(notify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100); // 重试
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('cancel 后不再触发', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockResolvedValue(true);
    const set = createReminderTool(notify);
    const cancel = createCancelReminderTool();
    await set.handler({ time: '10min', text: '取消我' });
    // ★ nextId 是模块级计数器，前面用例已递增——用 list 拿真实 id，不硬编码
    const listed = await createListRemindersTool().handler({});
    const m = listed.match(/^\[(\d+)\]/);
    expect(m).not.toBeNull();
    expect(await cancel.handler({ id: m![1] })).toContain('Cancelled reminder');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(notify).not.toHaveBeenCalled();
  });
});
