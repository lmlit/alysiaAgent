/**
 * bundle patch（`cordis.patch.yml`）的静态守卫。
 *
 * ★ 为什么需要它：patch 是**配置**，写错了不会在本地 `tsc`/单测里暴露——
 *   只有装进 dsh 才报，而 dsh 的错误信息对配置问题往往只说「跳过」。
 *   这里把能静态查的都查了，让真装那一步只剩「环境问题」这一类失败。
 *
 * 特别是**人设文本两处一致**：`cordis.patch.yml` 里的 `prefix` 与
 * `src/persona.ts` 的 `XILIAN_PERSONA` 是同一份内容的两个副本，
 * 漂移了不会有任何报错（只会让 dsh 里的昔涟和 alysia 里的昔涟说话不一样）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
import { PERSONA_VARIABLE } from '../src/index.ts';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(resolve(pkgDir, 'cordis.patch.yml'), 'utf-8');
// `!!js` 是 dsh Loader 的表达式标签，不是 YAML 标准标签 —— 声明它以免刷警告
const patch = parse(raw, {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => `!!js ${v}` }],
}) as Array<Record<string, unknown>>;

/** 从 patch 中取出 preset 声明的 config */
function presetConfig(): Record<string, any> {
  const insert = patch.find(row => Array.isArray(row.insert))!.insert as Array<Record<string, any>>;
  const preset = insert.find(row => row.id === 'preset-alysia-standard');
  expect(preset, 'patch 里找不到 preset-alysia 行').toBeDefined();
  return preset!.config;
}

describe('bundle patch / 结构', () => {
  it('顶层是插入列表，声明 host 行 + preset 行各一', () => {
    expect(Array.isArray(patch)).toBe(true);
    const inserts = patch.filter(r => Array.isArray(r.insert));
    expect(inserts).toHaveLength(1);
    const rows = inserts[0].insert as Array<Record<string, any>>;
    expect(rows.map(r => r.id)).toEqual(['alysia-persona', 'preset-alysia-standard']);
  });

  it('★ 人设变量由 host 行注册（不是 preset 插件）', () => {
    // 变量必须早于 persona 模板渲染就已注册，否则 dsh 对未知模板变量 throw，
    // 表现为「会话连请求都发不出去」的硬失败。见 src/persona-variable.ts。
    const rows = (patch[0].insert as Array<Record<string, any>>);
    const hostRow = rows.find(r => r.id === 'alysia-persona');
    expect(hostRow.name).toBe('@alysia/dsh-adapter/persona-variable');
    // host 行不在 preset 里 —— 它是顶层行，与 preset 平级
    expect(rows.find(r => r.id === 'preset-alysia-standard')).toBeDefined();
  });

  // ★ 命名约定（2026-10-02）：本 bundle 新增的 preset 一律
  //   Loader 行 id = `preset-alysia-<模式>`，config.id = `alysia-<模式>`，
  //   显示名 = `昔涟 · <模式>`。
  //   约定成文是为了「后续要加 昔涟 · PTC / 昔涟 · Cordis」时一眼能分辨。
  it('★ 命名约定：行 id / config.id / 显示名 三者都要带模式后缀', () => {
    const cfg = presetConfig();
    expect(cfg.id).toMatch(/^alysia-[a-z0-9-]+$/);
    const row = (patch[0].insert as Array<Record<string, any>>).find(r => r.config?.id === cfg.id);
    expect(row.id, 'Loader 行 id 应为 preset-<config.id>').toBe(`preset-${cfg.id}`);
    expect(cfg.name, '显示名应形如「昔涟 · 标准」以便与出厂模式并列时分辨').toMatch(/^昔涟 · /);
    // order 从 10 起：出厂是 1..4，我们这一族整体排在之后，不插进中间也不撞号
    expect(cfg.order, 'order 应从 10 起（出厂占 1..4）').toBeGreaterThanOrEqual(10);
  });

  it('preset 用 @deepseek-ai/dsh-agent-preset，id 是合法的小写连字符名', () => {
    const insert = patch[0].insert as Array<Record<string, any>>;
    const presetRow = insert.find(r => r.id === 'preset-alysia-standard');
    expect(presetRow.name).toBe('@deepseek-ai/dsh-agent-preset');
    const cfg = presetConfig();
    // dsh 要求 id 为小写字母/数字/连字符
    expect(cfg.id).toMatch(/^[a-z0-9-]+$/);
    expect(typeof cfg.name).toBe('string');
    expect(typeof cfg.order).toBe('number');
  });
});

describe('bundle patch / 插件行', () => {
  it('人设走 dsh 自带的 persona 行，**不带** complete（保留 harness 工具指导）', () => {
    const persona = presetConfig().plugins.find((p: any) => p.id === 'persona');
    expect(persona).toBeDefined();
    expect(persona.name).toBe('@deepseek-ai/dsh-persona');
    expect(persona.config.complete).toBeUndefined();
  });

  it('★ 人设走变量：prefix 引用的必须正是 alysia-adapter 注册的那个变量名', () => {
    // 两边漂移的后果**不是「人设不对」而是「渲染时 throw」**——
    // dsh 对未知模板变量严格校验，会话会直接发不出请求。
    // 所以这条比「文本一致」更关键：它守的是**能不能跑**，不只是内容对不对。
    const prefix = presetConfig().plugins.find((p: any) => p.id === 'persona').config.prefix as string;
    expect(prefix).toBe(`{{${PERSONA_VARIABLE}}}`);
  });

  it('★ 人格切换开关在 host 行上，且取值合法', () => {
    const rows = patch[0].insert as Array<Record<string, any>>;
    const hostRow = rows.find(r => r.id === 'alysia-persona');
    expect(['xilian', 'native']).toContain(hostRow.config?.persona);
  });

  it('工作目录段保留（操作上下文，不随人格切换）', () => {
    const cfg = presetConfig().plugins.find((p: any) => p.id === 'persona').config;
    expect(cfg.suffix).toBe('Your working directory is {{cwd}}.');
  });

  it('alysia 插件行指向本包（名字必须与 package.json 的 name 相同）', () => {
    const adapter = presetConfig().plugins.find((p: any) => p.id === 'alysia-adapter');
    expect(adapter).toBeDefined();
    const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'));
    expect(adapter.name).toBe(pkg.name);
  });
});

describe('bundle patch / ★ 与标准 preset 的兼容性', () => {
  /**
   * 出厂 `standard` preset 的插件 id 快照。
   *
   * ★ 为什么必须锁住：**选中「昔涟」不该丢工具**——
   *   曾经的版本只声明了 persona + alysia-adapter，选它就等于换了个空工具箱
   *   （bash/fs/web/todo/skill/delegation/compaction 全没了）。
   *   preset 是**自包含清单**，不是叠加层，所以兼容标准 = 我们得把那份清单带上。
   *
   * ⚠️ 快照自 dsh-desktop **0.2.0-rc.2** 的 `dsh-web-app/presets/standard.patch.yml`。
   *   **dsh 升级后要重新比对**——本测试只抓「我们这侧」的意外丢失，
   *   抓不到 dsh 那边新增了插件（那需要人工 diff，见 README.md）。
   */
  const STANDARD_PLUGIN_IDS = [
    'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs',
    'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill',
    'command-goal', 'tool-goal', 'planning', 'compaction', 'delegation',
    'tool-ask-user', 'tool-todo', 'tool-web', 'present', 'tool-plugin-manager',
  ];

  it('★ 覆盖标准 preset 的全部插件（去掉任意一条都会让「昔涟」少能力）', () => {
    const ids = presetConfig().plugins.map((p: any) => p.id);
    for (const id of STANDARD_PLUGIN_IDS) {
      expect(ids, `缺了标准 preset 的 ${id}`).toContain(id);
    }
  });

  it('在标准之上只多了 alysia-adapter（没悄悄塞别的）', () => {
    const ids: string[] = presetConfig().plugins.map((p: any) => p.id);
    const extra = ids.filter(i => !STANDARD_PLUGIN_IDS.includes(i));
    expect(extra).toEqual(['alysia-adapter']);
  });

  it('嵌套 group（planning/compaction/delegation）及其 isolate 原样保留', () => {
    // isolate 是「preset 内提供 service 必须 isolate」那条硬约束的落点——
    // 派生时丢了它，插件会永远 PENDING。
    const plugins = presetConfig().plugins;
    for (const id of ['planning', 'compaction', 'delegation']) {
      const g = plugins.find((p: any) => p.id === id);
      expect(g, `缺 ${id}`).toBeDefined();
      expect(g.group, `${id} 丢了 group:true`).toBe(true);
      expect(Object.keys(g.isolate ?? {}).length, `${id} 丢了 isolate`).toBeGreaterThan(0);
      expect(Array.isArray(g.config) && g.config.length, `${id} 的嵌套列表空了`).toBeGreaterThan(0);
    }
  });
});

describe('bundle patch / package.json', () => {
  it('声明了 dsh.bundle.patch 且文件存在', () => {
    const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'));
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
    // 存在性由上方的 readFileSync 隐式证明（读不到会抛）
    expect(raw.length).toBeGreaterThan(100);
  });

  it('★ 运行时零依赖（dsh 从安装处解析 dsh 包，装 bundle 不该联网拉依赖）', () => {
    const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});
