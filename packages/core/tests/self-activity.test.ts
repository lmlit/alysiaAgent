/**
 * 自发起决策的单测（★ change: `let-her-start-her-own-projects`）。
 *
 * 这些规则每一条都在**花真钱**、并且会**改变对外可见的东西**，
 * 所以逐条钉住 —— 而不是靠"跑一阵看看有没有乱发任务"。
 */
import { describe, it, expect } from 'vitest';
import {
  decideSelfActivity,
  selfActivityRequestKey,
  selfActivityAcceptanceCriteria,
  type SelfActivityDecisionInput,
} from '../src/memory/self-activity.js';

const BASE: SelfActivityDecisionInput = {
  enabled: true,
  offPeak: true,
  hasActiveTask: false,
  selfTasksToday: 0,
  dailyCap: 1,
  hoursSinceLastSelfTask: null,
  hoursSinceLastUserMessage: 12,
  minIdleHours: 6,
  minGapHours: 24,
};

const decide = (over: Partial<SelfActivityDecisionInput> = {}) =>
  decideSelfActivity({ ...BASE, ...over });

describe('★ 该不该让她自己找活干', () => {
  it('全部满足 → 可以', () => {
    const d = decide();
    expect(d.proceed).toBe(true);
    expect(d.reason).toBeUndefined();
    expect(d.detail).toContain('可以自己找点活');
  });

  it('★ 关了开关 → 不做（连"高峰/在途"都不用看）', () => {
    expect(decide({ enabled: false }).reason).toBe('disabled');
  });

  it('★★ 高峰时段 → 不做（钱按执行时间算，没有例外）', () => {
    const d = decide({ offPeak: false });
    expect(d.proceed).toBe(false);
    expect(d.reason).toBe('peak-hour');
  });

  it('★ 已有任务在排队/执行 → 不做（不叠加）', () => {
    expect(decide({ hasActiveTask: true }).reason).toBe('active-task');
  });

  it('★ 今日已达上限 → 不做（默认上限 1）', () => {
    expect(decide({ selfTasksToday: 1 }).reason).toBe('daily-cap');
  });

  it('★ 距上次自发起不足 24h → 不做（防"每天都想发一个"）', () => {
    expect(decide({ hoursSinceLastSelfTask: 23.9 }).reason).toBe('too-soon');
    expect(decide({ hoursSinceLastSelfTask: 24 }).proceed).toBe(true);
  });

  it('★★ 用户刚说过话 → 不做（用户在的时候应该陪用户，不是跑去干活）', () => {
    expect(decide({ hoursSinceLastUserMessage: 5.9 }).reason).toBe('not-idle');
    expect(decide({ hoursSinceLastUserMessage: 6 }).proceed).toBe(true);
  });

  it('从没聊过天 → 视为足够闲（不该因为"没有记录"就永远不干）', () => {
    expect(decide({ hoursSinceLastUserMessage: null }).proceed).toBe(true);
  });

  it('★ 判定顺序：高峰优先于"今日上限"（日志里先报更根本的原因）', () => {
    expect(decide({ offPeak: false, selfTasksToday: 5 }).reason).toBe('peak-hour');
  });

  it('上限/间隔传了非法值 → 用默认（不许因为配错就无限做）', () => {
    expect(decide({ dailyCap: Number.NaN }).proceed).toBe(true); // 0/NaN ⇒ 默认 1
    const d = decide({ dailyCap: Number.NaN, selfTasksToday: 1 });
    expect(d.reason).toBe('daily-cap');
  });
});

describe('requestKey / 验收标准', () => {
  it('★ 同一天同一项目 → 同一个 key（定时器抖动也不会重复建任务）', () => {
    expect(selfActivityRequestKey('2026-10-18', 'alysia-toys')).toBe('self:2026-10-18:alysia-toys');
    expect(selfActivityRequestKey('2026-10-18', 'alysia-toys')).toBe(
      selfActivityRequestKey('2026-10-18', 'alysia-toys'),
    );
  });

  it('不同天/不同项目 → 不同 key', () => {
    expect(selfActivityRequestKey('2026-10-18', 'a')).not.toBe(selfActivityRequestKey('2026-10-19', 'a'));
    expect(selfActivityRequestKey('2026-10-18', 'a')).not.toBe(selfActivityRequestKey('2026-10-18', 'b'));
  });

  it('★★ 默认**不要发布**（她可以自己决定做什么，但"上线"留给对话里的人）', () => {
    const c = selfActivityAcceptanceCriteria({ allowPublish: false });
    expect(c).toContain('不要发布');
    expect(c).toContain('不要跑 publish.sh');
    expect(c).not.toContain('四条判据必须全过');
  });

  it('明确允许时 → 要求发布并过四条判据', () => {
    const c = selfActivityAcceptanceCriteria({ allowPublish: true });
    expect(c).toContain('publish.sh');
    expect(c).toContain('四条判据必须全过');
  });

  it('两种情形都要求零外链 + 自己看一眼', () => {
    for (const allow of [true, false]) {
      const c = selfActivityAcceptanceCriteria({ allowPublish: allow });
      expect(c).toContain('零外链');
      expect(c).toContain('shot.sh');
    }
  });
});
