// tests/provider/manager.test.ts — ★ 8-10 abort 导致的 err 不算 provider 失败：
// 不打 WARN、不切 fallback（否则打断会误触发切换）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderManager } from '../../src/provider/manager.js';
import { logger } from '../../src/utils/logger.js';

// ★ spyOn 同一对象属性跨测试返回同一 spy（calls 累积）——每测试恢复，防污染
beforeEach(() => {
  vi.restoreAllMocks();
});

function makeConfig(id: string) {
  return { id, baseUrl: 'http://x', apiKey: 'k', model: 'm' } as any;
}

function makeReq(signal?: AbortSignal) {
  return { prompt: 'hi', sessionId: 's1', systemPrompt: '', contexts: [], signal } as any;
}

describe('ProviderManager textChatWithFallback', () => {
  it('正常 err → 打 WARN 并切 fallback', async () => {
    const manager = new ProviderManager();
    manager.registerProvider(makeConfig('primary'));
    manager.registerProvider(makeConfig('backup'));
    const primary = manager.getById('primary')!;
    const backup = manager.getById('backup')!;
    vi.spyOn(primary, 'textChat').mockResolvedValue({ role: 'err', completionText: 'boom' } as any);
    const backupSpy = vi.spyOn(backup, 'textChat').mockResolvedValue({ role: 'assistant', completionText: 'ok' } as any);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const resp = await manager.textChatWithFallback(makeReq(), ['backup']);
    expect(resp.completionText).toBe('ok');
    expect(warnSpy).toHaveBeenCalled();
    expect(backupSpy).toHaveBeenCalledTimes(1);
  });

  it('abort 导致的 err → 不打 WARN、不切 fallback（打断不烧钱）', async () => {
    const manager = new ProviderManager();
    manager.registerProvider(makeConfig('primary'));
    manager.registerProvider(makeConfig('backup'));
    const primary = manager.getById('primary')!;
    const backup = manager.getById('backup')!;
    vi.spyOn(primary, 'textChat').mockResolvedValue({ role: 'err', completionText: 'Request aborted' } as any);
    const backupSpy = vi.spyOn(backup, 'textChat');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const ctrl = new AbortController();
    ctrl.abort(); // 生成被新消息打断
    const resp = await manager.textChatWithFallback(makeReq(ctrl.signal), ['backup']);

    expect(resp.role).toBe('err');
    expect(resp.completionText).toBe('Request aborted');
    expect(warnSpy).not.toHaveBeenCalled(); // 不误报 provider 失败
    expect(backupSpy).not.toHaveBeenCalled(); // 不切 fallback
  });

  it('signal 已 abort（未发请求）→ 直接返回，不调任何 provider', async () => {
    const manager = new ProviderManager();
    manager.registerProvider(makeConfig('primary'));
    const primary = manager.getById('primary')!;
    const textChatSpy = vi.spyOn(primary, 'textChat');

    const ctrl = new AbortController();
    ctrl.abort();
    const resp = await manager.textChatWithFallback(makeReq(ctrl.signal), []);
    expect(resp.role).toBe('err');
    expect(textChatSpy).not.toHaveBeenCalled();
  });
});
