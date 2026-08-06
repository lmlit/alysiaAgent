import { describe, it, expect, vi, afterEach } from 'vitest';
import { QQOfficialAgentAdapter, parseStickerMarks } from '../src/adapters/qq-official.js';

/** 构造测试用 adapter：替换 token/网络/上传层，只观察发送行为 */
function makeAdapter(): any {
  const adapter = new QQOfficialAgentAdapter({ app_id: 'test-app', app_secret: 'test-secret' }) as any;
  adapter.ensureToken = vi.fn().mockResolvedValue(undefined);
  adapter.accessToken = 'test-token';
  adapter.stickerResolver = null;
  adapter.uploadImage = vi.fn().mockResolvedValue(null);
  return adapter;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseStickerMarks (proactive path)', () => {
  it('extracts sticker names and strips marks', () => {
    const { text, marks } = parseStickerMarks('晚安好梦哦 [表情包:睡觉]');
    expect(marks).toEqual(['睡觉']);
    expect(text).not.toContain('[表情包');
  });

  it('handles multiple stickers', () => {
    const { text, marks } = parseStickerMarks('a [表情包:嘻嘻] b [表情包:收到] c');
    expect(marks).toEqual(['嘻嘻', '收到']);
    expect(text).toBe('a b c');
  });

  it('returns text unchanged when no marks', () => {
    const { text, marks } = parseStickerMarks('普通消息');
    expect(text).toBe('普通消息');
    expect(marks).toEqual([]);
  });
});

describe('sendProactive — 主动消息表情包', () => {
  it('文本先发（剥标记），表情包图片随后私聊直发', async () => {
    const adapter = makeAdapter();
    adapter.stickerResolver = (name: string) => (name === '睡觉' ? '/tmp/sleep.png' : null);
    const upload = adapter.uploadImage;
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ code: 0 }) });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await adapter.sendProactive('openid123', '晚安好梦哦 [表情包:睡觉]');
    expect(ok).toBe(true);
    // 文本：一次 POST，正文不含标记
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v2/users/openid123/messages');
    expect(JSON.parse(init.body)).toMatchObject({ content: '晚安好梦哦', msg_type: 0 });
    expect(init.body).not.toContain('[表情包');
    // 图片：私聊直发 uploadImage
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(
      'private',
      expect.objectContaining({ author: { user_openid: 'openid123' } }),
      '/tmp/sleep.png'
    );
  });

  it('多表情包：逐个直发，全都能解析', async () => {
    const adapter = makeAdapter();
    adapter.stickerResolver = (name: string) => (name === '嘻嘻' || name === '收到' ? `/img/${name}.png` : null);
    const upload = adapter.uploadImage;
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ code: 0 }) });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await adapter.sendProactive('openid123', 'a [表情包:嘻嘻] b [表情包:收到] c');
    expect(ok).toBe(true);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map((c: any[]) => c[2])).toEqual(['/img/嘻嘻.png', '/img/收到.png']);
  });

  it('无标记：仅文本，不触发图片上传', async () => {
    const adapter = makeAdapter();
    const upload = adapter.uploadImage;
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ code: 0 }) });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await adapter.sendProactive('openid123', '普通消息');
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
  });

  it('文本发送失败：返回 false，不再发图', async () => {
    const adapter = makeAdapter();
    adapter.stickerResolver = () => '/tmp/sleep.png';
    const upload = adapter.uploadImage;
    const fetchMock = vi.fn().mockResolvedValue({ status: 400, json: async () => ({ code: 1001 }) });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await adapter.sendProactive('openid123', '消息 [表情包:睡觉]');
    expect(ok).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it('纯表情包消息：不发文本，只直发图片', async () => {
    const adapter = makeAdapter();
    adapter.stickerResolver = (name: string) => (name === '睡觉' ? '/tmp/sleep.png' : null);
    const upload = adapter.uploadImage;
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ code: 0 }) });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await adapter.sendProactive('openid123', '[表情包:睡觉]');
    expect(ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('表情包找不到图片：跳过上传，仍算成功', async () => {
    const adapter = makeAdapter();
    adapter.stickerResolver = () => null;
    const upload = adapter.uploadImage;
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ code: 0 }) });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await adapter.sendProactive('openid123', '[表情包:不存在的]');
    expect(ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('无文本也无表情包：返回 false', async () => {
    const adapter = makeAdapter();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const ok = await adapter.sendProactive('openid123', '   ');
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
