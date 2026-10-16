// tests/tools/filesystem.test.ts
// ★ 第三批（2026-10-16）· 文件工具边界
//
// 两个缺陷，都在 `safePath()` 里：
//
//   ① **同前缀目录绕过**：`resolved.startsWith(resolve(base))` 是**字符串前缀**比较，
//      而 `/ws-evil/x` 确实以 `/ws` 开头 —— 于是**工作区的兄弟目录**算"在工作区里"。
//
//   ② **创建目标时父目录软链不查**：软链检查写在 `if (existsSync(resolved))` 里，
//      而**待创建**的文件当然不存在 ⇒ 直接 `return resolved`。
//      若父目录是软链/junction 指向工作区外，写入会**真的写到外面去**。
//      （读路径不受影响：文件已存在 → 走 realpath 检查 → 能挡住。）
//
// 前提说明：本仓生产配置 `codeMode: false`（`packages/server/config.yml`），
// 这两个工具当前**不可达**（唯一打开它们的 Electron 壳已于 2026-09-25 砍掉）。
// 但 `registerCodeTools()` 是**公开方法** ⇒ 属**潜在**风险，仍按契约修。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, symlinkSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWriteFileTool, createReadFileTool } from '../../src/tools/filesystem.js';

let root: string;
let ws: string;
let outside: string;
let writer: ReturnType<typeof createWriteFileTool>;
let reader: ReturnType<typeof createReadFileTool>;

/** 工作区外的"秘密文件"，用来判断有没有真的写出去（在 beforeAll 里赋值） */
let SECRET: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'alysia-fs-'));
  ws = join(root, 'ws');
  outside = join(root, 'outside');
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  SECRET = join(outside, 'secret.txt');
  writeFileSync(SECRET, 'TOP SECRET', 'utf-8');
  // 兄弟目录：与 ws **同前缀**（`ws-evil` 以 `ws` 开头）——旧检查会放行
  mkdirSync(join(root, 'ws-evil'), { recursive: true });
  // 父目录软链：Windows 上用 junction（**不需要管理员权限**）
  symlinkSync(outside, join(ws, 'link'), process.platform === 'win32' ? 'junction' : 'dir');

  writer = createWriteFileTool(ws);
  reader = createReadFileTool(ws);
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 偶发占用，忽略 */ }
});

const w = (path: string, content = 'x') => writer.handler({ path, content });
const r = (path: string) => reader.handler({ path });

describe('★ 文件工具边界 — 同前缀目录（第三批）', () => {
  it('★★ 主症：`../ws-evil/…` 必须被拒（兄弟目录不是"在工作区里"）', async () => {
    const out = await w('../ws-evil/evil.txt');

    expect(out, '同前缀目录被当成了工作区内路径').toMatch(/❌/);
    expect(
      existsSync(join(root, 'ws-evil', 'evil.txt')),
      '文件真的被写到工作区外了',
    ).toBe(false);
  });

  it('★★ 主症：读工具同样拒绝同前缀目录', async () => {
    writeFileSync(join(root, 'ws-evil', 'peek.txt'), 'peek', 'utf-8');
    const out = await r('../ws-evil/peek.txt');
    expect(out).toMatch(/❌/);
  });

  it('回归：真正的 `../` 穿越照旧被拒', async () => {
    expect(await w('../outside/escape.txt')).toMatch(/❌/);
    expect(existsSync(join(outside, 'escape.txt'))).toBe(false);
  });
});

describe('★ 文件工具边界 — 创建目标时的父目录软链（第三批）', () => {
  it('★★ 主症：父目录是 junction → 新建文件不得写到工作区外', async () => {
    const out = await w('link/pwned.txt');

    expect(out, '沿着父目录软链写出去了').toMatch(/❌/);
    expect(
      existsSync(join(outside, 'pwned.txt')),
      '文件真的被写到了工作区外（junction 穿透）',
    ).toBe(false);
  });

  it('★ 覆盖**已存在**的文件也走同一条检查（不能靠"文件已存在"放行）', async () => {
    const out = await w('link/secret.txt', 'overwritten');

    expect(out).toMatch(/❌/);
    // 工作区外的秘密文件内容不得被改动
    const { readFileSync } = await import('fs');
    expect(readFileSync(SECRET, 'utf-8')).toBe('TOP SECRET');
  });

  it('回归：读路径本来就能挡住（文件已存在 → realpath 检查生效）', async () => {
    expect(await r('link/secret.txt')).toMatch(/❌/);
  });
});

describe('★ 文件工具边界 — 正常用法不受影响（回归）', () => {
  it('工作区内写入/读取照常', async () => {
    expect(await w('scripts/ok.txt', 'hello')).toMatch(/✅/);
    expect(await r('scripts/ok.txt')).toContain('hello');
  });

  it('直接写在根目录也照常', async () => {
    expect(await w('root.txt', 'hi')).toMatch(/✅/);
    expect(existsSync(join(ws, 'root.txt'))).toBe(true);
  });

  it('工作区**自己**的路径不算穿越（resolved === base 的边界）', async () => {
    // 前缀规则写成 `startsWith(base + sep)` 时，最容易误伤的就是 base 自身 ——
    // `resolved === base` 必须显式放行。对目录写文件会失败，但**不该是 traversal**。
    const out = await w('.', 'x');
    expect(out).not.toMatch(/traversal/i);
  });
});
