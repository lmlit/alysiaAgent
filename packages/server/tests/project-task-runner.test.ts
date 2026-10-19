// ★ 2026-10-17 · change: add-project-task-delegation
//
// 宿主侧 runner 的**纯函数**部分（拼命令 / 解析事件流 / 终态映射）。
//
// 为什么放在 server 包下：runner 是 `scripts/` 下的独立脚本（宿主上用 node 直跑），
// 仓库没有「scripts 的测试归属」，而它**只与 server 的 API 契约对话**，放这里最贴近。
//
// ⚠️ 真正的**副作用**（spawn dsh、HTTP 轮询）不在这里测 —— 那是真机验收的事。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error —— 宿主脚本是 .mjs，没有类型声明（故意的：它要能被 node 直跑）
import { buildDshArgs, buildTaskText, parseRunEvents, mapOutcome, nextUrl, collectFacts, buildPhaseTask, snapshotTree, inspectPhaseWrites, extractSection, timeoutForPhase, buildChildEnv, looksLikeResumeFailure, artifactPages } from '../../../scripts/project-task-runner.mjs';

// ══════════════════════════════════════════════════════════════
// ★ 2026-10-19（change: `wake-her-on-task-result`）：隔离与续接的四条纯函数
// ══════════════════════════════════════════════════════════════

describe('子进程环境变量白名单', () => {
  const src = {
    PATH: '/usr/bin',
    HOME: '/home/alysia-runner',
    DSH_HOME: '/srv/alysia-runner/.dsh',
    DEEPSEEK_API_KEY: 'sk-test',
    LANG: 'en_US.UTF-8',
    ALYSIA_RUNNER_TOKEN: 'runner-token',
    ALYSIA_WEBUI_TOKEN: 'ADMIN-SECRET',
    // 不该被透传的
    OPENAI_API_KEY: 'sk-other',
    ALYSIA_UNRELATED: 'x',
    AWS_SECRET_ACCESS_KEY: 'nope',
  };

  it('白名单内的原样保留；白名单外的**一律不带**', () => {
    const env = buildChildEnv(true, src as never);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.DSH_HOME).toBe('/srv/alysia-runner/.dsh');
    expect(env.DEEPSEEK_API_KEY).toBe('sk-test');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('ALYSIA_UNRELATED');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('★★ 管理令牌不进子进程：适配器只拿到**runner 令牌**', () => {
    const env = buildChildEnv(true, src as never);
    expect(env.ALYSIA_WEBUI_TOKEN, '管理令牌被透传给了 dsh —— 后台执行体握了管理面').toBe('runner-token');
  });

  it('没有 runner 令牌时退回旧变量（老部署不炸）', () => {
    const { ALYSIA_RUNNER_TOKEN, ...legacy } = src;
    const env = buildChildEnv(false, legacy as never);
    expect(env.ALYSIA_WEBUI_TOKEN).toBe('ADMIN-SECRET');
    expect(env.ALYSIA_ALLOW_PUBLISH).toBe('0');
  });

  it('allowPublish 透传成 ALYSIA_ALLOW_PUBLISH', () => {
    expect(buildChildEnv(true, src as never).ALYSIA_ALLOW_PUBLISH).toBe('1');
    expect(buildChildEnv(false, src as never).ALYSIA_ALLOW_PUBLISH).toBe('0');
  });
});

describe('续接失败的辨别', () => {
  it('dsh 说会话不存在 → 认出来（该丢 id 重开）', () => {
    expect(looksLikeResumeFailure({ stderr: 'Error: unknown session abc', stdout: '' })).toBe(true);
    expect(looksLikeResumeFailure({ stderr: '', stdout: 'session not found' })).toBe(true);
  });

  it('普通失败 / 空输出 → 不认（不该重开，那会白跑一遍）', () => {
    expect(looksLikeResumeFailure({ stderr: 'build failed', stdout: '' })).toBe(false);
    expect(looksLikeResumeFailure({ stderr: '', stdout: '' })).toBe(false);
  });
});

describe('返工轮的任务正文', () => {
  it('★ 返工要把**原目标**带上（否则到了工程环境只看得到修改意见）', () => {
    const text = buildTaskText({
      ...task,
      revision: 1,
      goal: '颜色再冷一点',
      originalGoal: '做一个月光花园',
    });
    expect(text).toContain('最初的目标：做一个月光花园');
    expect(text).toContain('这一轮要我改的是：颜色再冷一点');
  });

  it('没有 originalGoal（老数据/测试替身）→ 行为同以前，不炸', () => {
    const text = buildTaskText({ ...task, revision: 1, goal: '改一下' });
    expect(text).toContain('改一下');
    expect(text).not.toContain('最初的目标');
  });
});

describe('产物带 mtime（服务端判"是不是这一轮的"）', () => {
  it('artifactPages 返回的文件都带 mtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-art-'));
    writeFileSync(join(dir, 'moon.html'), '<html></html>');
    const pages = artifactPages(dir, 0, () => false);
    expect(pages).toHaveLength(1);
    expect(typeof pages[0].mtime).toBe('number');
    expect(pages[0].mtime).toBeGreaterThan(0);
  });
});

const task = {
  taskId: 'pt-1', goal: '做一个关于我页面', acceptanceCriteria: '能构建', revision: 0, dshSessionId: null,
};

describe('拼命令', () => {
  it('★ 首轮**不带** --session-id（带了会报 unknown id）', () => {
    const args = buildDshArgs(task, 'alysia');
    expect(args).toContain('--profile');
    expect(args[args.indexOf('--profile') + 1]).toBe('alysia');
    expect(args).toContain('--json');
    expect(args, '首轮带了 --session-id').not.toContain('--session-id');
  });

  it('★★ 续作**必须**带 --session-id（不带就等于重新建站）', () => {
    const args = buildDshArgs({ ...task, revision: 2, dshSessionId: 'session-abc' }, 'alysia');
    expect(args[args.indexOf('--session-id') + 1]).toBe('session-abc');
  });

  it('任务正文含目标与验收标准（验收标准要进执行体，不能只留在服务端）', () => {
    const text = buildTaskText(task);
    expect(text).toContain('做一个关于我页面');
    expect(text).toContain('验收标准：能构建');
  });

  it('★ 续作轮要在正文里点明「同一个工程会话」（否则她可能重新搭）', () => {
    const text = buildTaskText({ ...task, revision: 3 });
    expect(text).toContain('同一个工程会话');
    expect(text).toContain('不要重新搭');
  });
});

describe('解析 dsh 的 --json 事件流', () => {
  const stream = [
    '{"type":"session","sessionId":"session-1","cwd":"/root/alysia-blog"}',
    '{"type":"status","phase":"turn_start","turn":1}',
    '{"type":"text","text":"开始"}',
    '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
    '{"type":"final","text":"做完了"}',
  ].join('\n');

  it('取出 sessionId / 终态 reason / final 文本', () => {
    const r = parseRunEvents(stream);
    expect(r.sessionId).toBe('session-1');
    expect(r.reason).toBe('completed');
    expect(r.finalText).toBe('做完了');
    expect(r.badLines).toBe(0);
  });

  it('★ 坏行要计数（非 JSON 混进来时不能静默当成「没输出」）', () => {
    const r = parseRunEvents(`${stream}\n这不是 JSON\n也不像 JSON`);
    expect(r.badLines).toBe(2);
    expect(r.reason, '坏行把好行也带偏了').toBe('completed');
  });

  it('空输入不抛（拿不到东西就是拿不到）', () => {
    expect(parseRunEvents('')).toEqual({ sessionId: null, reason: null, finalText: '', badLines: 0 });
  });
});

describe('★ 终态映射（runner 永远不写 completed）', () => {
  it('★★ dsh 正常结束 → **needs_review**，不是 completed', () => {
    const r = mapOutcome({ reason: 'completed', timedOut: false });
    expect(r.status, 'runner 把「跑完了」当成「验收通过」了 —— 那属于验收方，不属于执行方')
      .toBe('needs_review');
  });

  it('dsh 报错结束 → failed（有明确失败证据）', () => {
    expect(mapOutcome({ reason: 'error', timedOut: false }).status).toBe('failed');
  });

  it('★ 拿不到 reason → unknown，且说明**不自动重投**', () => {
    const r = mapOutcome({ reason: null, timedOut: false });
    expect(r.status).toBe('unknown');
    expect(r.error).toContain('无法确认');
  });

  it('★ 超时 → unknown（不许当成 failed 去重投：远端可能已经做完了）', () => {
    const r = mapOutcome({ reason: null, timedOut: true });
    expect(r.status).toBe('unknown');
    expect(r.error).toContain('不自动重投');
  });

  it('全量枚举：四种输入都不会产出 completed', () => {
    for (const input of [
      { reason: 'completed', timedOut: false },
      { reason: 'error', timedOut: false },
      { reason: null, timedOut: false },
      { reason: 'completed', timedOut: true },
    ]) {
      expect(mapOutcome(input).status).not.toBe('completed');
    }
  });
});

// ★ 2026-10-18 真机撞出来的：runner 按项目起服务（`--project alysia-blog`）⇒
//   新登记的项目**永远没人认领**，任务一路 queued 而且是静默的（实测等了 580 秒才发现）。
//   改成：不传 project ⇒ 不带查询参数 ⇒ 服务端挑"还有活的最老的项目"。
describe('★ 认领 URL（不指定项目 = 服务所有项目）', () => {
  it('★ 不传 project → **不带**查询参数（交给服务端决定）', () => {
    expect(nextUrl('')).toBe('/api/project-tasks/next');
    expect(nextUrl(undefined as unknown as string)).toBe('/api/project-tasks/next');
  });

  it('传了 project → 带 projectId（隔离/调试用）', () => {
    expect(nextUrl('alysia-blog')).toBe('/api/project-tasks/next?projectId=alysia-blog');
  });

  it('项目 id 要 encode（不能把特殊字符塞进 query）', () => {
    expect(nextUrl('a b&c')).toBe('/api/project-tasks/next?projectId=a%20b%26c');
  });
});

// ★ 2026-10-18（change: `make-author-iterate`）
//   状态机的**事实**必须从文件系统读出来（不能采信模型自述）。
describe('★ 阶段推进：从工作区读事实', () => {
  const TASK = {
    taskId: 'pt-1', requestKey: 'k', projectId: 'p', originSessionId: 's',
    origin: 'delegated', goal: '做一个页面', acceptanceCriteria: '零外链',
    dshSessionId: null, status: 'running', revision: 0, result: null, artifacts: null,
    attempts: 1, lastError: null, createdAt: '', updatedAt: '', phase: 'intent', loopState: {},
  } as never;

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'facts-'));
    mkdirSync(join(root, 'drafts'));
    mkdirSync(join(root, 'shots'));
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'NOTES.md'), '## 意图\n想做点安静的\n');
    writeFileSync(join(root, 'drafts', 'a.html'), '<p>a');
    writeFileSync(join(root, 'drafts', 'b.html'), '<p>b');
    writeFileSync(join(root, 'shots', 'draft-a.png'), 'x');
    writeFileSync(join(root, 'page.html'), '<p>full');
    return root;
  }

  it('★ 读得出 notes/drafts/shots/builtPages', () => {
    const root = fixture();
    const f = collectFacts(root);
    expect(f.notes).toContain('意图');
    expect(f.drafts).toEqual(['a.html', 'b.html']);
    expect(f.shots).toContain('draft-a.png');
    expect(f.builtPages.map((p: { file: string }) => p.file)).toContain('page.html');
    // 草稿不算"做出来的页面"
    expect(f.builtPages.map((p: { file: string }) => p.file)).not.toContain('drafts/a.html');
  });

  it('★ published 只在 public/ 里出现同名页面时为真', () => {
    const root = fixture();
    expect(collectFacts(root).published).toBe(false);
    writeFileSync(join(root, 'public', 'page.html'), '<p>full');
    expect(collectFacts(root).published).toBe(true);
  });

  it('工作区不存在也不抛（返回空事实）', () => {
    const f = collectFacts(join(tmpdir(), 'definitely-not-here-' + Date.now()));
    expect(f.notes).toBe('');
    expect(f.drafts).toEqual([]);
    expect(f.builtPages).toEqual([]);
  });

  // ★ 2026-10-18（change: `scope-loop-to-this-round`）：同一工作区做第二个任务时，
  //   上一轮的 drafts / 截图 / 页面不能算这一轮的 —— 否则闸门"什么都不做也能过"。
  it('★★ 给了 sinceMs ⇒ 只返回这一轮动过的（上一轮的草稿不算）', () => {
    const root = fixture();
    const past = (Date.now() - 3600_000) / 1000;
    // 把 fixture 里的一切都装成"上一轮的"
    for (const rel of ['NOTES.md', 'drafts/a.html', 'drafts/b.html', 'shots/draft-a.png', 'page.html']) {
      utimesSync(join(root, rel), past, past);
    }
    const since = Date.now() - 60_000;
    const f = collectFacts(root, since);
    expect(f.drafts).toEqual([]);
    expect(f.shots).toEqual([]);
    expect(f.builtPages).toEqual([]);
    expect(f.notesMtime, '上一轮的笔记时间戳要能读出来').toBeLessThan(since);

    // 这一轮写了新草稿 + 拍图 + 做了页面
    writeFileSync(join(root, 'drafts', 'c.html'), '<p>c');
    writeFileSync(join(root, 'shots', 'draft-c.png'), 'x');
    writeFileSync(join(root, 'island.html'), '<p>toy');
    const f2 = collectFacts(root, since);
    expect(f2.drafts).toEqual(['c.html']);
    expect(f2.shots).toEqual(['draft-c.png']);
    expect(f2.builtPages.map((p: { file: string }) => p.file)).toEqual(['island.html']);
  });

  it('不给 sinceMs ⇒ 老行为（全工作区，兼容单测与旧 runner）', () => {
    const root = fixture();
    expect(collectFacts(root).drafts).toEqual(['a.html', 'b.html']);
  });

  it('★ 超时按阶段给（build 必须比 intent 宽得多）', () => {
    expect(timeoutForPhase('build')).toBeGreaterThan(timeoutForPhase('intent'));
    expect(timeoutForPhase('build')).toBeGreaterThanOrEqual(3600);
    expect(timeoutForPhase('intent')).toBeGreaterThanOrEqual(600);
    // 显式 --timeout 统一覆盖（排障要能压短）
    expect(timeoutForPhase('build', 120)).toBe(120);
    // 未知阶段有兜底
    expect(timeoutForPhase('something-new')).toBe(1800);
  });

  it('★ 阶段指令拼在任务正文后面，且**不覆盖**原始目标', () => {
    const text = buildPhaseTask(TASK, '第二轮：只画草图');
    expect(text).toContain('做一个页面');   // 原目标还在
    expect(text).toContain('只画草图');     // 本轮指令也在
    expect(text).toContain('这一轮只做这一件事');
  });

  it('没有阶段指令时 = 原样任务正文（一次性任务不受影响）', () => {
    expect(buildPhaseTask(TASK, '')).toBe(buildTaskText(TASK));
  });
});

// ★ 2026-10-19（change: `give-her-a-publish-tool`）：**"事后没收"整个废掉了。**
//
// 三次真机代价（都记在这条 describe 里，防止以后有人把没收加回来）：
//   ① sketch 轮她写了整页 ⇒ 988 / 53 个文件被搬走（含 63 张她拍的截图）
//   ② 我的枚举式白名单漏了 `AGENTS.md`，又在轮次中间改它 ⇒ 她的说明书被搬走，那轮没有 workspace instructions
//   ③ 她按任务要求**把页面发布进 `public/`** ⇒ 整站 7 个文件被搬走，**站点断了一分钟**
//
// 结论：路径白名单不是能力边界（她本来就能 `cp`；真边界是 dsh 的 bwrap 沙箱），
// 唯一有效的作用是把她的成果弄坏。⇒ 现在**只记账、不搬文件**；上线走 `publish_page` 工具。
describe('★ 阶段写入：只记账，不搬文件', () => {
  it('★★ 改了 AGENTS.md / 写了整页 ⇒ 一个文件都不动', () => {
    const root = mkdtempSync(join(tmpdir(), 'writes-'));
    writeFileSync(join(root, 'AGENTS.md'), '# 旧说明\n');
    const before = snapshotTree(root);
    writeFileSync(join(root, 'AGENTS.md'), '# 旧说明\n\n新加的一节\n');
    writeFileSync(join(root, 'island.html'), '<p>她提前写的整页');
    const rb = inspectPhaseWrites(root, before, 'sketch', 1);
    expect(rb.violations, '工作区里的东西不算"越界"').toEqual([]);
    expect(rb.moved).toEqual([]);
    expect(existsSync(join(root, 'AGENTS.md')), '文档被搬走了').toBe(true);
    expect(existsSync(join(root, 'island.html')), '页面被搬走了').toBe(true);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('新加的一节');
  });

  it('★ `.tmp/` 不进快照（工具缓存，否则每轮上千条噪音）', () => {
    const root = mkdtempSync(join(tmpdir(), 'skip-tmp-'));
    mkdirSync(join(root, '.tmp', 'npm-cache'), { recursive: true });
    writeFileSync(join(root, '.tmp', 'npm-cache', 'x.json'), '{}');
    writeFileSync(join(root, '.tmp', 'scratch.js'), 'x');
    writeFileSync(join(root, 'island.html'), '<p>她的页面');
    const snap = snapshotTree(root);
    expect(Object.keys(snap)).toEqual(['island.html']);
  });

  it('★ 绕过 publish_page 直接写 public/ ⇒ 记账（不搬），并说清该走工具', () => {
    const root = mkdtempSync(join(tmpdir(), 'pubtouch-'));
    writeFileSync(join(root, 'NOTES.md'), '## 意图\n原来就有\n');
    const before = snapshotTree(root);

    writeFileSync(join(root, 'island.html'), '<p>这一轮做的页面');
    mkdirSync(join(root, 'public'), { recursive: true });
    writeFileSync(join(root, 'public', 'island.html'), '<p>她直接 cp 进去的');

    const rb = inspectPhaseWrites(root, before, 'statement', 6);
    expect(rb.violations.length, '只记 public/ 那一处').toBe(1);
    expect(rb.violations[0]).toContain('public/island.html');
    expect(rb.moved).toEqual([]);
    // ★ 关键：**发布出去的东西没被搬走**（上次就是这么把站点弄断的）
    expect(existsSync(join(root, 'public', 'island.html')), '发布物被搬走了').toBe(true);
    expect(existsSync(join(root, 'island.html'))).toBe(true);
  });

  it('publish 阶段动 public/ 是正常动作 ⇒ 不记账', () => {
    const root = mkdtempSync(join(tmpdir(), 'pubok-'));
    mkdirSync(join(root, 'public'), { recursive: true });
    const before = snapshotTree(root);
    writeFileSync(join(root, 'public', 'island.html'), '<p>发布');
    const rb = inspectPhaseWrites(root, before, 'publish', 3);
    expect(rb.violations).toEqual([]);
    expect(existsSync(join(root, 'public', 'island.html'))).toBe(true);
  });

  it('extractSection 取出「哪里像我」（与服务端同规则）', () => {
    const notes = '## 意图\nx\n## 哪里像我\n像我不爱说话\n## 别的\nzz\n';
    expect(extractSection(notes, '哪里像我')).toBe('像我不爱说话');
    expect(extractSection(notes, '不存在')).toBe('');
  });
});
