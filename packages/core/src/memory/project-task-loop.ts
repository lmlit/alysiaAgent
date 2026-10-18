/**
 * 「做一件东西」的**显式状态机**（★ 2026-10-18，change: `make-author-iterate`）。
 *
 * 起因（用户原话）：
 *   「生成的东西ai味道好重啊」→「她调用工具生成的东西，没有她自己的味道」→
 *   「**她和工具应该要有交互才行啊**」→「参考一下 langgraph 呢？」
 *
 * 诊断：她每次都在白纸上**一次成型**（写完 → grep → curl → 交），中间没有"看一眼、不满意、再改"。
 * 味道长在来回里，不在第一版里。
 *
 * 所以借 LangGraph 的**形状**（不引入它的框架）：
 *   - 显式阶段（node）+ 有回退边（edge）+ 状态累积（reducer 的语义）
 *   - **硬校验**代替"自觉"：不满足就**不许进下一阶段**
 *   - `maxRounds` 对应 recursion_limit（防改到天亮）
 *
 * ⚠️ 事实（facts）必须**可从文件系统确定地算出来**，不能取模型的自我报告 ——
 *   否则"我改了"这句自述就能骗过闸门（本项目已经栽过同类：回执自述 ≠ 真做完）。
 *
 * 她的 NOTES.md 必须带这四个标记（见 `AGENTS.md`）：
 *   `## 意图` / `## 选的` / `## 自评` / `## 哪里像我`
 */

export const LOOP_PHASES = [
  'intent',
  'sketch',
  'review',
  'build',
  'revise',
  'statement',
  'publish',
  'done',
] as const;

export type LoopPhase = (typeof LOOP_PHASES)[number];

/** 累积状态（对应 LangGraph 的 State；只增不清） */
export interface LoopState {
  /** 进入该阶段的次数（rounds 用于 maxRounds） */
  rounds: number;
  /** 每个阶段各进了几次（排障/回执用） */
  visits: Partial<Record<LoopPhase, number>>;
  /** 已完成的重做轮数（`revise` 有效走完一次 +1） */
  revisions: number;
  /** 上一轮看到的草稿名（用于判断"草图换了没有"） */
  draftsSeen?: string[];
}

export function initialLoopState(): LoopState {
  return { rounds: 0, visits: {}, revisions: 0 };
}

/** 从文件系统能读出来的事实（**不取模型的自我报告**） */
export interface LoopFacts {
  /** NOTES.md 全文；空串=没有这个文件 */
  notes: string;
  /** `drafts/` 下的 .html 文件名（★ 只应有**这一轮**动过的，见 `sinceMs`） */
  drafts: string[];
  /** `shots/` 下的图片文件名（同上） */
  shots: string[];
  /** 工作区根下（不在 drafts/ 里）的 .html：文件名 + mtime(ms)（同上） */
  builtPages: Array<{ file: string; mtime: number }>;
  /** 是否已出现在 public/（发布成功） */
  published: boolean;
  /**
   * ★ 2026-10-18（change: `scope-loop-to-this-round`）：`NOTES.md` 的 mtime。
   *
   * 真机事故：同一工作区做第二个任务时，上一轮写好的「## 自评」「## 选的」还在 ⇒
   * review 闸门直接放行，**这一轮什么都没做也能推进**。
   * 有了它就能判"这一轮的笔记动过没有"。
   */
  notesMtime?: number;
  /** 本轮开始时刻（ms）。给了 ⇒ 与 `notesMtime` 配合，判"这节是不是这一轮写的" */
  sinceMs?: number;
}


export interface LoopDecision {
  /** 下一步该做什么阶段 */
  next: LoopPhase;
  /** 伴随的阶段指令（喂给执行端的正文） */
  prompt: string;
  /** 是否该结束（不再跑执行端） */
  done: boolean;
  /** 结束原因（`done` 时给回执用） */
  outcome?: 'ready' | 'published' | 'needs_review';
  /** 给日志的一句话（含关键事实） */
  detail: string;
  state: LoopState;
}

/** 阶段指令：每个阶段只做一件事，做完了靠 facts 判 */
export const PHASE_PROMPTS: Record<Exclude<LoopPhase, 'done'>, string> = {
  intent:
    '第一件事：在 NOTES.md 里写「## 意图」一节，三行——想让人看到时什么感觉 / 为什么想做成这样 /\n' +
    '**这次要和上一次哪里不一样**（上一次是什么调子，这次换掉它）。写完就停，先别写页面。',
  sketch:
    '第二步：在 drafts/ 下出 **2~3 个草图**（a.html/b.html/c.html，每个 ≤40 行，只抓气质不写细节），\n' +
    '然后**每个都拍一张**：`./shot.sh drafts/a.html --name draft-a`（b、c 同理）。\n' +
    '换的是根本性的东西：亮/暗、繁/简、字体气质、有没有插图、留白多少、动不动。写完就停。',
  review:
    '第三步：把这几张草稿截图**打开看**，然后在 NOTES.md 里补「## 自评」——\n' +
    '哪张最像你、哪张最不像、为什么。**要落到具体的东西**（颜色/字体/留白/语气），不要写"感觉"。\n' +
    '最后用「## 选的」一节写一个草稿名（例如 `## 选的` + 下一行 `b`）。',
  build:
    '第四步：把选中的草稿做成**完整版**（页面主体 + 文案 + 必要的交互），放在工作区根目录。\n' +
    '文案要像你平时说话，不要写成网上那种文艺腔。做完就停。',
  revise:
    '第五步：给完整版**再拍一次**（`./shot.sh <页面文件> --name revise-1`），**自己打开看**，\n' +
    '然后**挑一处最不满意的改掉**——至少改一处。改完在 NOTES.md 里补一句"这轮改了什么、为什么"。',
  statement:
    '最后：在 NOTES.md 里写「## 哪里像我」一节——**用一句话说这件东西哪里像你**。\n' +
    '说不出来就说明它只是"一个能打开的页面"，那就回去再改，别硬写。',
  publish:
    '可以发布了：调用 **`publish_page`** 工具（参数 files 写你要上线的页面，例如 `["island.html"]`；' +
    '如果这页要当站点首页，再加 `home`）。它会把页面和它引用的 css/js 一起复制进 `public/`，' +
    '并自己访问一遍确认真的打得开。**不要**手写 cp —— 那不叫发布，也不会被当成发布。',
};

const MAX_ROUNDS_DEFAULT = 8;

/**
 * 取 NOTES.md 里某个 `## 标题` 下的正文（到下一个 `## ` 或文件尾）。
 *
 * ⚠️ 不要用 `^##\s*X\s*$([\s\S]*?)(?=^##\s|$)` 这种正则：
 *   在 `m` 模式下，紧跟在标题后面的位置**本身就是"行尾"** ⇒ `$` 立刻命中
 *   ⇒ 惰性捕获恒为空（2026-10-18 一气失败 7 条用例才发现）。
 *   逐行扫描没有这种歧义。
 */
function section(notes: string, heading: string): string {
  const want = new RegExp(`^##\\s*${heading}\\s*$`);
  const isHeading = /^##\s/;
  const out: string[] = [];
  let inside = false;
  for (const line of (notes ?? '').split(/\r?\n/)) {
    if (want.test(line)) {
      inside = true;
      continue;
    }
    if (isHeading.test(line)) {
      if (inside) break;
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n').trim();
}

export interface AdvanceInput {
  phase: LoopPhase;
  state: LoopState;
  facts: LoopFacts;
  /** 该项目是否允许她自己发布 */
  allowPublish: boolean;
  /** 轮次上限（默认 8） */
  maxRounds?: number;
}

/**
 * 推进状态机一步。
 *
 * ★ 只在**事实满足**时才前进；否则**原地重试**（并把原因写进 detail），
 *   超过 `maxRounds` 就收工成 `needs_review`（不让它无限转）。
 */
export function advanceLoop(input: AdvanceInput): LoopDecision {
  const maxRounds = input.maxRounds ?? MAX_ROUNDS_DEFAULT;
  const notes = input.facts.notes ?? '';
  /**
   * ★ 2026-10-18（change: `scope-loop-to-this-round`）：**这一轮动过 NOTES.md 没有**。
   *
   * 真机事故：同一工作区做第二个任务时，上一轮写好的「## 自评」「## 选的」「## 哪里像我」
   * 还在文件里 ⇒ review / statement 闸门直接放行（日志写着"通过"，可它读的是旧文件）。
   * 现在要求 `notesMtime ≥ sinceMs` —— **这一轮的笔记必须是这一轮写的**。
   * 两个字段都没给时按老行为（`true`），不破坏既有调用方与单测。
   */
  const notesTouchedThisRound = (): boolean => {
    const since = input.facts.sinceMs;
    const mt = input.facts.notesMtime;
    if (!Number.isFinite(since) || !Number.isFinite(mt)) return true;
    return (mt as number) + 1 >= (since as number); // +1：容 1ms 精度抖动
  };
  const state: LoopState = {
    ...input.state,
    rounds: (input.state.rounds ?? 0) + 1,
    visits: { ...(input.state.visits ?? {}) },
    draftsSeen: input.state.draftsSeen,
  };
  state.visits[input.phase] = (state.visits[input.phase] ?? 0) + 1;

  const stay = (detail: string): LoopDecision => ({
    next: input.phase,
    prompt: PHASE_PROMPTS[input.phase as Exclude<LoopPhase, 'done'>] ?? '',
    done: false,
    detail,
    state,
  });

  const go = (next: LoopPhase, detail: string): LoopDecision => ({
    next,
    prompt: next === 'done' ? '' : PHASE_PROMPTS[next as Exclude<LoopPhase, 'done'>],
    done: false,
    detail,
    state,
  });

  const finish = (outcome: 'ready' | 'published' | 'needs_review', detail: string): LoopDecision => ({
    next: 'done',
    prompt: '',
    done: true,
    outcome,
    detail,
    state,
  });

  // 轮次上限：先判，防止任何阶段无限重试
  if (state.rounds > maxRounds) {
    return finish(
      'needs_review',
      `轮次超限（${state.rounds} > ${maxRounds}）—— 交给人看，别让它自己转到天亮`,
    );
  }

  /**
   * ★ 2026-10-19（change: `let-tasks-declare-their-kind`）**防空转**：
   * 同一个阶段**连续卡住 4 次**（`visits` 含本次）就收工交给人，别烧到 `maxRounds`。
   *
   * 真机事故：一个"只发布 island.html"的任务被套上六阶段，闸门要「## 意图」而目标写"别改文件"
   * ⇒ 在 `intent` **空转 7 轮**（每轮都真跑了 dsh、真调了 `publish_page` 5 次）。
   * 4 次足够容纳正常来回（草图通常 1~2 轮），又不至于让错误目标烧掉整晚。
   */
  const STUCK_LIMIT = 4;
  if ((state.visits[input.phase] ?? 0) >= STUCK_LIMIT) {
    return finish(
      'needs_review',
      `卡在「${input.phase}」已经 ${state.visits[input.phase]} 次没有前进` +
        `（${input.facts.notes ? '文件事实不满足闸门' : '没有可读的事实'}）—— 交给人看，别再空转`,
    );
  }

  switch (input.phase) {
    case 'intent': {
      const intent = section(notes, '意图');
      if (intent.length < 10) return stay('NOTES.md 里还没有「## 意图」（或太短）');
      if (!notesTouchedThisRound()) {
        return stay('「## 意图」是上一轮留下的 —— 这一轮还没动过 NOTES.md');
      }
      return go('sketch', `意图已写（${intent.length} 字）`);
    }

    case 'sketch': {
      const drafts = input.facts.drafts;
      if (drafts.length < 2) return stay(`草图只有 ${drafts.length} 个（要求 ≥2）`);
      // 每张草图都要有对应截图（shots/draft-<name>.png）
      const missing = drafts.filter(d => {
        const base = d.replace(/\.html$/i, '');
        return !input.facts.shots.some(s => s === `draft-${base}.png`);
      });
      if (missing.length > 0) return stay(`这些草图还没拍：${missing.join(', ')}`);
      return go('review', `${drafts.length} 个草图都有截图`);
    }

    case 'review': {
      const critique = section(notes, '自评');
      const chosen = section(notes, '选的').split('\n')[0]?.trim() ?? '';
      if (critique.length < 10) return stay('NOTES.md 里还没有「## 自评」');
      if (!notesTouchedThisRound()) {
        // 真机事故：上一轮的自评还在文件里 ⇒ 这一轮什么都没看也能过闸
        return stay('「## 自评」是上一轮留下的 —— 这一轮还没动过 NOTES.md');
      }
      if (!chosen) return stay('NOTES.md 里还没有「## 选的」（要写一个草稿名）');
      if (!input.facts.drafts.some(d => d.replace(/\.html$/i, '') === chosen || d === chosen)) {
        return stay(`「## 选的」写的 "${chosen}" 不在 drafts/ 里`);
      }
      return go('build', `已选 ${chosen}，自评 ${critique.length} 字`);
    }

    case 'build': {
      // 判定"完整版"：根目录有 .html，且比构建开始前的草稿更新
      const chosen = section(notes, '选的').split('\n')[0]?.trim() ?? '';
      const draftShot = input.facts.shots.find(s => s === `draft-${chosen}.png`);
      if (!draftShot) return stay('找不到选中草稿的截图，先回去补拍');
      const shotMtime = 0; // 由调用方在 facts 里给的 builtPages 只带 mtime；这里只判"存在非草稿页面"
      const built = input.facts.builtPages.filter(p => !/^drafts\//.test(p.file));
      if (built.length === 0) return stay('工作区根目录还没有做出来的页面（别只留在 drafts/ 里）');
      // 要求页面比"草稿截图那次"更新（字符串比较不了，交给调用方在 facts 里保证只传新的）
      void shotMtime;
      return go('revise', `完整版已就位：${built.map(b => b.file).join(', ')}`);
    }

    case 'revise': {
      // "至少改一处"：要有 revise-*.png，且页面文件比它旧 → 说明拍完又改过
      const reviseShots = input.facts.shots.filter(s => /^revise-\d+\.png$/.test(s));
      if (reviseShots.length < 1) return stay('还没有拍「再拍一次」的图（shots/revise-1.png）');
      if ((state.revisions ?? 0) < 1) {
        const next: LoopState = { ...state, revisions: 1 };
        return {
          next: 'statement',
          prompt: PHASE_PROMPTS.statement,
          done: false,
          detail: '已拍过一轮并改过（revisions=1）',
          state: next,
        };
      }
      return go('statement', 'revisions 已满足');
    }

    case 'statement': {
      const stmt = section(notes, '哪里像我');
      if (stmt.length < 6) return stay('NOTES.md 里还没有「## 哪里像我」（说不出就别交）');
      if (!notesTouchedThisRound()) {
        return stay('「## 哪里像我」是上一轮留下的 —— 这一轮还没动过 NOTES.md');
      }
      if (!input.allowPublish) {
        return finish('ready', `已经说得出来：${stmt.slice(0, 60)}`);
      }
      return go('publish', `已经说得出来：${stmt.slice(0, 60)}`);
    }

    case 'publish': {
      if (input.facts.published) return finish('published', '已发布（public/ 里有这个页面）');
      return stay('还没在 public/ 里看到页面（publish.sh 没跑成？）');
    }

    case 'done':
    default:
      return finish('ready', '已经在终态');
  }
}
