// ★ 2026-10-18（change: `give-author-eyes`）
//
// 委托方是**文本模型**：她能 grep 出「零外链」、能 curl 出 200，但**看不见页面长什么样**。
// 布局塌了、字被裁了，她的自检照样全绿 —— 这一层给她一双眼睛。
//
// 契约要点（都在这里钉住）：
//   · 没有视觉模型 ⇒ **501 明确不可用**，不许假装成功
//   · 入参 base64（可带 dataURL 前缀）、空/坏/超大都要**明确拒绝**
//   · 图片经**容器内临时文件**交给 VisionBridge（不依赖容器能不能访问宿主端口）
//   · 临时文件**必须删掉**（哪怕描述失败）
//   · 模型没返回描述 ⇒ 502（不是 200 + 空字符串）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { existsSync, readFileSync } from 'fs';
import { createWebuiApp } from '../src/webui/server.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function build(opts: Record<string, unknown>) {
  const app = createWebuiApp({ memoryManager: {} } as never, { requireAuth: false, ...opts } as never);
  await app.ready();
  return app;
}

describe('POST /api/vision/describe —— 给她一双眼睛', () => {
  it('★ 没有视觉模型 → 501，并且说清「能力不存在，不是你的错」', async () => {
    const app = await build({});
    const res = await app.inject({
      method: 'POST', url: '/api/vision/describe', payload: { imageBase64: PNG_1PX },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toContain('没有配置视觉模型');
  });

  it('★ 正常路径：把图写进临时文件交给 describe，返回文字，并把临时文件删掉', async () => {
    let seenPath = '';
    let existedDuringCall = false;
    const vision = {
      describe: vi.fn(async (p: string) => {
        seenPath = p;
        existedDuringCall = existsSync(p);
        // 确认交给模型的就是我们那张图（不是空文件）
        expect(readFileSync(p).length).toBeGreaterThan(0);
        return '页面顶部是一个大标题，右侧有一幅拱窗插图，下方三张卡片。';
      }),
    };
    const app = await build({ vision });
    const res = await app.inject({
      method: 'POST', url: '/api/vision/describe', payload: { imageBase64: PNG_1PX },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('大标题');
    expect(res.json().bytes).toBeGreaterThan(0);
    expect(existedDuringCall, 'describe 被调用时临时文件必须已存在').toBe(true);
    expect(seenPath).toMatch(/alysia-vision-.*\.png$/);
    expect(existsSync(seenPath), '描述完必须删掉临时文件').toBe(false);
  });

  it('★ dataURL 前缀要能剥掉（调用方常直接塞 dataURL）', async () => {
    const vision = { describe: vi.fn(async () => 'ok') };
    const app = await build({ vision });
    const res = await app.inject({
      method: 'POST', url: '/api/vision/describe',
      payload: { imageBase64: `data:image/png;base64,${PNG_1PX}` },
    });
    expect(res.statusCode).toBe(200);
    expect(vision.describe).toHaveBeenCalledTimes(1);
  });

  it('缺 imageBase64 → 400（说清楚缺什么）', async () => {
    const app = await build({ vision: { describe: vi.fn(async () => 'ok') } });
    const res = await app.inject({ method: 'POST', url: '/api/vision/describe', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('imageBase64');
  });

  it('★ 模型没返回描述 → 502（不许 200 + 空字符串骗人）', async () => {
    const app = await build({ vision: { describe: vi.fn(async () => null) } });
    const res = await app.inject({
      method: 'POST', url: '/api/vision/describe', payload: { imageBase64: PNG_1PX },
    });
    expect(res.statusCode).toBe(502);
  });

  it('describe 抛异常 → 500，且**仍然**删掉临时文件', async () => {
    const paths: string[] = [];
    const app = await build({
      vision: {
        describe: vi.fn(async (p: string) => {
          paths.push(p);
          throw new Error('GLM 挂了');
        }),
      },
    });
    const res = await app.inject({
      method: 'POST', url: '/api/vision/describe', payload: { imageBase64: PNG_1PX },
    });
    expect(res.statusCode).toBe(500);
    for (const p of paths) expect(existsSync(p), '失败也要清理临时文件').toBe(false);
  });

  it('自定义 prompt 要透传给视觉模型', async () => {
    const vision = { describe: vi.fn(async (_p: string, _prompt?: string) => 'ok') };
    const app = await build({ vision });
    await app.inject({
      method: 'POST', url: '/api/vision/describe',
      payload: { imageBase64: PNG_1PX, prompt: '只看配色' },
    });
    expect(vision.describe.mock.calls[0][1]).toBe('只看配色');
  });

  it('不传 prompt → 用「看网页截图」的默认提问（含排版问题排查）', async () => {
    const vision = { describe: vi.fn(async (_p: string, _prompt?: string) => 'ok') };
    const app = await build({ vision });
    await app.inject({
      method: 'POST', url: '/api/vision/describe', payload: { imageBase64: PNG_1PX },
    });
    const prompt = vision.describe.mock.calls[0][1] as string;
    expect(prompt).toContain('排版');
    expect(prompt).toContain('不要猜');
  });
});
