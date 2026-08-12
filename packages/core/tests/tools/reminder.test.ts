import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createReminderTool,
  createListRemindersTool,
  createCancelReminderTool,
  restoreReminders,
} from '../../src/tools/reminder.js';
import type { ReminderPersist } from '../../src/tools/reminder.js';

/** 内存 fake persist（模拟 SQLite 存取） */
function makePersist(): ReminderPersist & { saved: Array<{ id: string; triggerAt: Date }> } {
  const saved: Array<{ id: string; triggerAt: Date }> = [];
  return {
    saved,
    save: (id, r) => { saved.push({ id, triggerAt: r.triggerAt }); },
    remove: (id) => { const i = saved.findIndex(s => s.id === id); if (i >= 0) saved.splice(i, 1); },
  };
}

/** reminders 是模块级单例——测试间用 list+cancel 清空隔离 */
async function clearAllReminders(persist: ReminderPersist) {
  const list = createListRemindersTool();
  const out = await list.handler({});
  if (out === 'No active reminders.') return;
  const cancel = createCancelReminderTool(persist);
  for (const line of out.split('\n')) {
    const m = line.match(/^\[(reminder-[\d-]+)\]/);
    if (m) await cancel.handler({ id: m[1] });
  }
}

describe('reminder tool — 8-08 可靠性 + 8-12 持久化', () => {
  let persist: ReturnType<typeof makePersist>;
  beforeEach(() => { persist = makePersist(); return clearAllReminders(persist); });
  afterEach(() => vi.useRealTimers());

  it('正常到点触发 notifyFn 并移除（fire 即消费落库）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockResolvedValue(true);
    const set = createReminderTool(notify, persist);
    const res = await set.handler({ time: '30min', text: '喝水' }, 'qq-official-1:private:private_abc');
    expect(res).toContain('Reminder set');
    expect(persist.saved).toHaveLength(1); // set 即落库
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 100);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('喝水', 'qq-official-1:private:private_abc');
    // 触发后已移除（内存 + 落库）
    expect(await createListRemindersTool().handler({})).toBe('No active reminders.');
    expect(persist.saved).toHaveLength(0);
  });

  it('超长提醒（>24.8 天）被拒绝，不触发 Node setTimeout 立即执行陷阱', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockResolvedValue(true);
    const set = createReminderTool(notify, persist);
    const res = await set.handler({ time: '600h', text: '超长提醒' });
    expect(res).toContain('Error: Reminder too far in the future');
    await vi.advanceTimersByTimeAsync(1); // 无定时器被立即触发
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifyFn 返回 false → 5min 重试一次（重试也落库）→ 再失败丢弃', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockResolvedValue(false);
    const set = createReminderTool(notify, persist);
    await set.handler({ time: '10min', text: '测试' });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 100); // 首次触发失败
    expect(notify).toHaveBeenCalledTimes(1);
    expect(persist.saved).toHaveLength(1); // 重试提醒重新落库（retry 副本）
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100); // 重试一次
    expect(notify).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * 60_000); // 不再重试
    expect(notify).toHaveBeenCalledTimes(2);
    expect(await createListRemindersTool().handler({})).toBe('No active reminders.');
  });

  it('notifyFn throw → 同样走重试预算', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockRejectedValue(new Error('sendProactive 网络错误'));
    const set = createReminderTool(notify, persist);
    await set.handler({ time: '10min', text: '测试' });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 100);
    expect(notify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100); // 重试
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('cancel 后不再触发，且落库删除', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockResolvedValue(true);
    const set = createReminderTool(notify, persist);
    const cancel = createCancelReminderTool(persist);
    await set.handler({ time: '10min', text: '取消我' });
    const listed = await createListRemindersTool().handler({});
    const m = listed.match(/^\[(reminder-[\d-]+)\]/);
    expect(m).not.toBeNull();
    expect(await cancel.handler({ id: m![1] })).toContain('Cancelled reminder');
    expect(persist.saved).toHaveLength(0); // 取消即删除落库
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(notify).not.toHaveBeenCalled();
  });

  // ===== 8-12 持久化：启动恢复 =====

  it('restore 未过期提醒 → 重挂 timer 到时触发', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockResolvedValue(true);
    restoreReminders(notify, persist, [
      { id: 'reminder-1', text: '开会', triggerAt: new Date(2026, 7, 8, 13, 0, 0), sessionId: 's1', retryCount: 0 },
    ]);
    expect(await createListRemindersTool().handler({})).toContain('reminder-1');
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 100); // 到 13:00
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('开会', 's1');
  });

  it('restore 已过期提醒 → 立即补发（不丢）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockResolvedValue(true);
    restoreReminders(notify, persist, [
      { id: 'reminder-2', text: '错过了也要提醒', triggerAt: new Date(2026, 7, 8, 11, 30, 0), sessionId: 's1', retryCount: 0 },
    ]);
    await vi.advanceTimersByTimeAsync(10); // flush fire 异步链
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('错过了也要提醒', 's1');
    expect(await createListRemindersTool().handler({})).toBe('No active reminders.');
  });

  it('restore 混合：未过期重挂 + 过期补发', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0));
    const notify = vi.fn().mockResolvedValue(true);
    restoreReminders(notify, persist, [
      { id: 'r-future', text: '未来', triggerAt: new Date(2026, 7, 8, 14, 0, 0), sessionId: 's1', retryCount: 0 },
      { id: 'r-past', text: '过去', triggerAt: new Date(2026, 7, 8, 10, 0, 0), sessionId: 's1', retryCount: 0 },
    ]);
    await vi.advanceTimersByTimeAsync(10);
    expect(notify).toHaveBeenCalledTimes(1); // 只有过期的立即补发
    expect(notify).toHaveBeenCalledWith('过去', 's1');
    expect(await createListRemindersTool().handler({})).toContain('r-future'); // 未来的还在
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 100); // 到 14:00
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith('未来', 's1');
  });
});
