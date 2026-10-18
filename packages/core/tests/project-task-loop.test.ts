/**
 * 「做一件东西」状态机单测（★ change: `make-author-iterate`）。
 *
 * 这些规则决定了"她能不能一次成型就交" —— 所以逐条钉住。
 * 每条都带**反向守卫**：合法路径不许被误伤（否则她会永远卡在某一步）。
 */
import { describe, it, expect } from 'vitest';
import {
  advanceLoop,
  initialLoopState,
  LOOP_PHASES,
  PHASE_PROMPTS,
  type LoopFacts,
  type LoopPhase,
} from '../src/memory/project-task-loop.js';

const NOTES_FULL = `
## 意图
想让人看到时安静下来。因为时间本来就是慢慢走的。这次不搞深色星空，试试纸感。

## 自评
b 最像我：留白多、没有装饰、字是主角。a 太花，c 像模板。

## 选的
b

## 哪里像我
像我不爱说话但一直在那儿待着。
`;

const FACTS: LoopFacts = {
  notes: NOTES_FULL,
  drafts: ['a.html', 'b.html', 'c.html'],
  shots: ['draft-a.png', 'draft-b.png', 'draft-c.png', 'revise-1.png'],
  builtPages: [{ file: 'clock-v2.html', mtime: Date.now() }],
  published: false,
};

const run = (phase: LoopPhase, over: Partial<LoopFacts> = {}, allowPublish = false) =>
  advanceLoop({
    phase,
    state: initialLoopState(),
    facts: { ...FACTS, ...over },
    allowPublish,
  });

describe('阶段清单与指令', () => {
  it('阶段是这条链（一字不差）', () => {
    expect(LOOP_PHASES).toEqual([
      'intent', 'sketch', 'review', 'build', 'revise', 'statement', 'publish', 'done',
    ]);
  });

  it('每个非终态阶段都有指令（不许空跑）', () => {
    for (const p of LOOP_PHASES) {
      if (p === 'done') continue;
      expect(PHASE_PROMPTS[p as Exclude<LoopPhase, 'done'>]?.length, p).toBeGreaterThan(20);
    }
  });
});

describe('intent：先写意图，写不好不许往下', () => {
  it('没有 NOTES → 原地', () => {
    const d = run('intent', { notes: '' });
    expect(d.done).toBe(false);
    expect(d.next).toBe('intent');
    expect(d.detail).toContain('意图');
  });

  it('意图太短（敷衍）→ 原地', () => {
    expect(run('intent', { notes: '## 意图\n想做点什么' }).next).toBe('intent');
  });

  it('意图写够了 → sketch', () => {
    const d = run('intent');
    expect(d.next).toBe('sketch');
    expect(d.prompt).toContain('草图');
  });
});

describe('sketch：至少 2 个草图，且每个都拍过', () => {
  it('只有 1 个 → 原地', () => {
    const d = run('sketch', { drafts: ['a.html'], shots: ['draft-a.png'] });
    expect(d.next).toBe('sketch');
    expect(d.detail).toContain('≥2');
  });

  it('★ 有草图但没拍 → 原地，并点名缺哪个', () => {
    const d = run('sketch', { shots: ['draft-a.png'] });
    expect(d.next).toBe('sketch');
    expect(d.detail).toContain('b.html');
  });

  it('都齐了 → review', () => {
    expect(run('sketch').next).toBe('review');
  });
});

describe('review：要有自评 + 明确的"选的"', () => {
  it('没自评 → 原地', () => {
    const notes = NOTES_FULL.replace(/## 自评[\s\S]*?(?=## 选的)/, '');
    expect(run('review', { notes }).next).toBe('review');
  });

  it('没写"选的" → 原地', () => {
    const notes = NOTES_FULL.replace(/## 选的\nb\n/, '');
    expect(run('review', { notes }).next).toBe('review');
  });

  it('★ "选的"写了个不存在的草稿 → 原地（防止她随口写一个名字）', () => {
    const notes = NOTES_FULL.replace('## 选的\nb', '## 选的\nz');
    const d = run('review', { notes });
    expect(d.next).toBe('review');
    expect(d.detail).toContain('z');
  });

  it('齐全 → build', () => {
    expect(run('review').next).toBe('build');
  });
});

describe('build：必须真的做出页面（不许只留在 drafts/）', () => {
  it('根目录没有页面 → 原地', () => {
    const d = run('build', { builtPages: [] });
    expect(d.next).toBe('build');
    expect(d.detail).toContain('根目录');
  });

  it('只有 drafts/ 里的 → 也算没有', () => {
    const d = run('build', { builtPages: [{ file: 'drafts/b.html', mtime: 1 }] });
    expect(d.next).toBe('build');
  });

  it('有页面 → revise', () => {
    expect(run('build').next).toBe('revise');
  });
});

describe('★ revise：至少改一处才算过', () => {
  it('没拍"再拍一次" → 原地', () => {
    const d = run('revise', { shots: ['draft-a.png', 'draft-b.png', 'draft-c.png'] });
    expect(d.next).toBe('revise');
    expect(d.detail).toContain('revise-1');
  });

  it('拍了 → 进 statement，并把 revisions 记成 1', () => {
    const d = run('revise');
    expect(d.next).toBe('statement');
    expect(d.state.revisions).toBe(1);
  });
});

describe('statement：说不出"哪里像我"就不许交', () => {
  it('没写 → 原地', () => {
    const notes = NOTES_FULL.replace(/## 哪里像我[\s\S]*$/, '');
    const d = run('statement', { notes });
    expect(d.next).toBe('statement');
    expect(d.detail).toContain('哪里像我');
  });

  it('★ 不许发布时：写完直接收工（outcome=ready）', () => {
    const d = run('statement');
    expect(d.done).toBe(true);
    expect(d.outcome).toBe('ready');
  });

  it('允许发布时：先走 publish', () => {
    const d = run('statement', {}, true);
    expect(d.next).toBe('publish');
  });
});

describe('publish 与终态', () => {
  it('public/ 里还没有 → 原地', () => {
    const d = run('publish', {}, true);
    expect(d.next).toBe('publish');
    expect(d.detail).toContain('public/');
  });

  it('已发布 → 收工（outcome=published）', () => {
    const d = run('publish', { published: true }, true);
    expect(d.done).toBe(true);
    expect(d.outcome).toBe('published');
  });
});

describe('★ 轮次上限（对应 LangGraph 的 recursion_limit）', () => {
  it('超过上限 → needs_review（交给人，不许转到天亮）', () => {
    const d = advanceLoop({
      phase: 'sketch',
      state: { ...initialLoopState(), rounds: 8 },
      facts: { ...FACTS, drafts: [] },
      allowPublish: false,
      maxRounds: 8,
    });
    expect(d.done).toBe(true);
    expect(d.outcome).toBe('needs_review');
    expect(d.detail).toContain('轮次超限');
  });

  it('刚好到上限还没超 → 仍可继续', () => {
    const d = advanceLoop({
      phase: 'intent',
      state: { ...initialLoopState(), rounds: 6 },
      facts: FACTS,
      allowPublish: false,
      maxRounds: 8,
    });
    expect(d.done).toBe(false);
  });
});

describe('状态累积（reducer 语义：只增不清）', () => {
  it('rounds 与 visits 会累加，且不改原对象', () => {
    const before = initialLoopState();
    const d = advanceLoop({ phase: 'intent', state: before, facts: FACTS, allowPublish: false });
    expect(before.rounds).toBe(0); // 不可变
    expect(d.state.rounds).toBe(1);
    expect(d.state.visits.intent).toBe(1);
  });

  it('同一阶段再次进入 → visits 递增（能看出她卡在哪）', () => {
    let st = initialLoopState();
    st = advanceLoop({ phase: 'sketch', state: st, facts: { ...FACTS, drafts: [] }, allowPublish: false }).state;
    st = advanceLoop({ phase: 'sketch', state: st, facts: { ...FACTS, drafts: [] }, allowPublish: false }).state;
    expect(st.visits.sketch).toBe(2);
  });
});

// ★ 2026-10-18（change: `scope-loop-to-this-round`）
//   真机事故：同一工作区做第二个任务时，上一轮写好的「## 自评」「## 选的」「## 哪里像我」
//   还在 NOTES.md 里 ⇒ review / statement 闸门直接放行（日志写着"通过"，读的却是旧文件）。
//   现在要求 `notesMtime ≥ sinceMs`：**这一轮的笔记必须是这一轮写的**。
describe('★★ 判据只看这一轮（上一轮的笔记不算数）', () => {
  const SINCE = 1_000_000;
  const STALE = SINCE - 5000; // 上一轮写的
  const FRESH = SINCE + 5000; // 这一轮写的

  it.each([['intent'], ['review'], ['statement']] as const)(
    '%s：笔记是上一轮留下的 → 原地重试，且说清原因',
    (phase) => {
      const d = run(phase, { notesMtime: STALE, sinceMs: SINCE });
      expect(d.done).toBe(false);
      expect(d.next).toBe(phase);
      expect(d.detail).toContain('上一轮');
    },
  );

  it.each([['intent'], ['review'], ['statement']] as const)(
    '%s：笔记是这一轮写的 → 照常前进（合法路径不许误伤）',
    (phase) => {
      const d = run(phase, { notesMtime: FRESH, sinceMs: SINCE });
      expect(d.detail).not.toContain('上一轮');
      // ⚠️ `statement` 在 `allowPublish=false` 时本来就**收工**（outcome=ready），
      //    所以这里不能一律断言 done=false —— 只看"有没有被误判成上一轮"。
      if (phase !== 'statement') expect(d.done).toBe(false);
      else expect(d.done && d.outcome === 'ready', 'statement 应正常收工为 ready').toBe(true);
    },
  );

  it('两个字段都没给 → 按老行为（不破坏既有调用方 / 老 runner）', () => {
    const d = run('review');
    expect(d.next).toBe('build');
  });
});
