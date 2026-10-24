/**
 * 块注册表的守卫（★ 2026-10-25，change: `assembler-block-registry`；P8 第 2 步）
 *
 * 这次重构的**证明标准**是既有 characterization 快照逐字不变（见同目录那份测试）——
 * 本文件守的是注册表自身的三件事：
 *   1. `CHAT_BLOCKS` 与 `ChatBlockKey` 一一对应（少一个 key ⇒ 某块永远不可能被注入）
 *   2. `CHAT_BLOCK_POLICY` 由注册表**派生**（手写两份必然漂移）
 *   3. `effect: 'write'` 只出现在**确有其事**的块上（当前只有 pendingConfirm）
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_BLOCKS, CODE_BLOCKS,
  CHAT_BLOCK_POLICY, CODE_BLOCK_POLICY,
  CHAT_BLOCK_ORDER, CODE_BLOCK_ORDER,
  WRITE_EFFECT_CHAT_BLOCKS,
} from '../../../src/memory/index';

/** 与 `ChatBlockKey` 联合类型等价的运行期清单 —— 类型新增而忘了登记时，这里会红 */
const ALL_CHAT_KEYS = [
  'selfNotice', 'persona', 'overlay', 'basics', 'preferences',
  'facts', 'characterFacts', 'pendingConfirm', 'recentConversations',
  'worldbook', 'life', 'memories', 'brevity',
] as const;

const ALL_CODE_KEYS = ['persona', 'techProfile', 'projectContext', 'worldbook', 'life', 'memories'] as const;

describe('块注册表 —— 完整性', () => {
  it('★ chat：13 个 key 全部登记，且没有多余项', () => {
    expect(CHAT_BLOCKS).toHaveLength(ALL_CHAT_KEYS.length);
    expect([...CHAT_BLOCK_ORDER].sort()).toEqual([...ALL_CHAT_KEYS].sort());
  });

  it('★ code：6 个 key 全部登记', () => {
    expect(CODE_BLOCKS).toHaveLength(ALL_CODE_KEYS.length);
    expect([...CODE_BLOCK_ORDER].sort()).toEqual([...ALL_CODE_KEYS].sort());
  });

  it('每个 key 只出现一次（重复 = 顺序与预算语义说不清）', () => {
    expect(new Set(CHAT_BLOCK_ORDER).size).toBe(CHAT_BLOCK_ORDER.length);
    expect(new Set(CODE_BLOCK_ORDER).size).toBe(CODE_BLOCK_ORDER.length);
  });

  it('每块都必须写明数据源（"这块钱从哪来"要能追溯）', () => {
    for (const b of [...CHAT_BLOCKS, ...CODE_BLOCKS]) {
      expect(b.source.trim(), `${b.key} 缺 source`).not.toBe('');
    }
  });
});

describe('块注册表 —— 策略由注册表派生', () => {
  it('★ CHAT_BLOCK_POLICY 与注册表一致（不是第二份手写）', () => {
    for (const b of CHAT_BLOCKS) {
      expect(CHAT_BLOCK_POLICY[b.key]).toBe(b.policy);
    }
    expect(Object.keys(CHAT_BLOCK_POLICY)).toHaveLength(CHAT_BLOCKS.length);
  });

  it('CODE_BLOCK_POLICY 同理', () => {
    for (const b of CODE_BLOCKS) {
      expect(CODE_BLOCK_POLICY[b.key]).toBe(b.policy);
    }
  });

  it('required 只有 selfNotice / persona / brevity', () => {
    const required = CHAT_BLOCKS.filter((b) => b.policy === 'required').map((b) => b.key);
    expect(required).toEqual(['selfNotice', 'persona', 'brevity']);
  });
});

describe('块注册表 —— effect 声明', () => {
  it('★ 会写库的块只有 pendingConfirm（读路径带写副作用）', () => {
    expect([...WRITE_EFFECT_CHAT_BLOCKS]).toEqual(['pendingConfirm']);
  });

  it('★ 该块的 note 必须说清"为什么读路径要写"（否则这条声明会变成没人敢动的黑盒）', () => {
    const b = CHAT_BLOCKS.find((x) => x.key === 'pendingConfirm')!;
    expect(b.effect).toBe('write');
    expect(b.note).toMatch(/expireStaleFacts|writeFacts/);
  });

  it('code 表全是纯读（编程模式不该在组装时写库）', () => {
    expect(CODE_BLOCKS.every((b) => b.effect === 'read')).toBe(true);
  });
});
