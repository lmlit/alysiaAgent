import { describe, it, expect } from 'vitest';
// @ts-expect-error —— 部署工具是纯 .mjs（root scripts/），只做决策、不参与打包
import {
  DEFAULT_KEEP,
  ROLLBACK_TAG_RE,
  buildPruneScript,
  parseImageList,
  planRollbackPrune,
  resolveKeep,
} from '../../../scripts/lib/rollback-retention.mjs';

/**
 * ★ 2026-10-25：这些用例存在的理由不是"覆盖代码"，而是钉住三条**删错就会事故**的边界：
 *   ① `latest` 永远不出现在待删集合里；
 *   ② 排序用 CreatedAt（生产上真有 `rollback-20261017` 这种无时分秒的标签名）
 *      —— 按名字排会把"最老"的当成"最新"的留下；
 *   ③ 生成的 bash 里只能出现合法 `rollback-*` 标签（防注入 / 防误删）。
 */

const img = (createdAt: string, tag: string, id = 'sha256:x') => ({ createdAt, tag, id });

describe('parseImageList — docker images 输出解析', () => {
  it('解析 createdAt|tag|id，跳过空行', () => {
    const text = [
      '2026-10-25 18:26:10 +0800 CST|server-alysia:rollback-20261025-182610|16a3db63',
      '',
      '2026-10-25 18:30:00 +0800 CST|server-alysia:latest|5525c04f',
      '   ',
    ].join('\n');
    const list = parseImageList(text);
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual({ createdAt: '2026-10-25 18:30:00 +0800 CST', tag: 'server-alysia:latest', id: '5525c04f' });
  });

  it('没有 tag 的残缺行不会变成记录', () => {
    expect(parseImageList('2026-10-25 18:26:10 +0800 CST||abc\n')).toHaveLength(0);
  });
});

describe('planRollbackPrune — 保留策略', () => {
  const tags = [
    img('2026-10-25 18:26:10 +0800 CST', 'server-alysia:rollback-20261025-182610', 'a'),
    img('2026-10-25 18:08:08 +0800 CST', 'server-alysia:rollback-20261025-180808', 'b'),
    img('2026-10-25 17:52:52 +0800 CST', 'server-alysia:rollback-20261025-175252', 'c'),
    img('2026-10-25 17:18:07 +0800 CST', 'server-alysia:rollback-20261025-171807', 'd'),
    img('2026-10-15 10:00:00 +0800 CST', 'server-alysia:rollback-20261015-pre-reflection-fix', 'e'),
  ];

  it('默认保留最近 3 个，其余进删除集合', () => {
    const plan = planRollbackPrune(tags);
    expect(plan.keepCount).toBe(DEFAULT_KEEP);
    expect(plan.keep.map((e) => e.tag)).toEqual([
      'server-alysia:rollback-20261025-182610',
      'server-alysia:rollback-20261025-180808',
      'server-alysia:rollback-20261025-175252',
    ]);
    expect(plan.remove.map((e) => e.tag)).toEqual([
      'server-alysia:rollback-20261025-171807',
      'server-alysia:rollback-20261015-pre-reflection-fix',
    ]);
  });

  it('★ latest 永远进不了待删集合（即使它是"最旧"的）', () => {
    const plan = planRollbackPrune([
      img('2020-01-01 00:00:00 +0800 CST', 'server-alysia:latest', 'old'),
      img('2026-10-25 18:26:10 +0800 CST', 'server-alysia:rollback-20261025-182610', 'new'),
    ], 0);
    expect(plan.remove.map((e) => e.tag)).toEqual(['server-alysia:rollback-20261025-182610']);
    expect(plan.ignored.map((e) => e.tag)).toEqual(['server-alysia:latest']);
  });

  it('★ 排序看 CreatedAt，不看标签名（`rollback-20261017` 这种名字会骗过字典序）', () => {
    // 名字 "rollback-20261017" 字典序小于 "rollback-20261018-004247"，
    // 但 CreatedAt 更新 ⇒ 必须算"较新"。
    const plan = planRollbackPrune(
      [
        img('2026-10-17 20:00:00 +0800 CST', 'server-alysia:rollback-20261017', 'x'),
        img('2026-10-18 00:42:47 +0800 CST', 'server-alysia:rollback-20261018-004247', 'y'),
      ],
      1,
    );
    expect(plan.keep.map((e) => e.tag)).toEqual(['server-alysia:rollback-20261018-004247']);
    expect(plan.remove.map((e) => e.tag)).toEqual(['server-alysia:rollback-20261017']);
  });

  it('同一 CreatedAt（一个镜像多个标签）时结果确定，不因输入顺序变化', () => {
    const same = '2026-10-25 01:05:56 +0800 CST';
    const a = img(same, 'server-alysia:rollback-20261025-010544', 'f06d');
    const b = img(same, 'server-alysia:rollback-20261025-010556', 'f06d');
    const p1 = planRollbackPrune([a, b], 1);
    const p2 = planRollbackPrune([b, a], 1);
    expect(p1.keep.map((e) => e.tag)).toEqual(p2.keep.map((e) => e.tag));
    expect(p1.remove.map((e) => e.tag)).toEqual(p2.remove.map((e) => e.tag));
  });

  it('keep=0 时只留 latest', () => {
    const plan = planRollbackPrune([...tags, img('2026-10-25 18:30:00 +0800 CST', 'server-alysia:latest', 'l')], 0);
    expect(plan.keep).toHaveLength(0);
    expect(plan.remove).toHaveLength(tags.length);
  });

  it('非法 keep 退回默认值（不抛、不把库删空）', () => {
    for (const bad of [undefined, null, NaN, -1, 'abc']) {
      const plan = planRollbackPrune(tags, bad as never);
      expect(plan.keepCount).toBe(DEFAULT_KEEP === 3 ? 3 : DEFAULT_KEEP);
      expect(plan.keep.length + plan.remove.length).toBe(tags.length);
    }
  });

  it('别的仓库/别的标签一律不动', () => {
    const plan = planRollbackPrune(
      [img('2026-10-25 18:26:10 +0800 CST', 'halohub/halo:2.20', 'h'), img('2026-10-25 18:26:10 +0800 CST', 'server-alysia:dev', 'd')],
      0,
    );
    expect(plan.remove).toHaveLength(0);
    expect(plan.ignored).toHaveLength(2);
  });
});

describe('buildPruneScript — 生成的远程脚本', () => {
  it('只删合法 rollback 标签，latest 不出现在 rmi 行', () => {
    const s = buildPruneScript([
      'server-alysia:rollback-20261025-171807',
      'server-alysia:latest',
      'server-alysia:rollback-bad tag; rm -rf /',
    ]);
    const rmiLine = s.split('\n').find((l) => l.includes('docker rmi'))!;
    expect(rmiLine).toContain('server-alysia:rollback-20261025-171807');
    expect(rmiLine).not.toContain('latest');
    expect(rmiLine).not.toContain('rm -rf');
    expect(s).toContain('removed=1');
  });

  it('非法标签全被丢掉时仍然安全（removed=0 且不打 rmi）', () => {
    const s = buildPruneScript(['server-alysia:latest', '; rm -rf /']);
    expect(s).not.toContain('docker rmi');
    expect(s).toContain('removed=0');
  });

  it('悬空清理带 compose project 的 label 过滤（不误删别人的 <none>）', () => {
    const s = buildPruneScript([]);
    expect(s).toContain("label=com.docker.compose.project=server");
    expect(s).not.toMatch(/prune\s+-f\s+(-a|--all)/);
  });

  it('脚本自带验收输出：latest 存在性 / 健康 / 磁盘', () => {
    const s = buildPruneScript(['server-alysia:rollback-20261001-000000']);
    expect(s).toContain('latest=present');
    expect(s).toContain('health=%{http_code}');
    expect(s).toContain('disk=');
  });
});

describe('resolveKeep — 保留数量的来源', () => {
  it('--keep-rollbacks=N 与空格形式都支持', () => {
    expect(resolveKeep({ argv: ['--keep-rollbacks=5'] })).toBe(5);
    expect(resolveKeep({ argv: ['--keep-rollbacks', '2'] })).toBe(2);
  });

  it('环境变量次之，命令行优先', () => {
    expect(resolveKeep({ argv: [], env: { ALYSIA_ROLLBACK_KEEP: '7' } })).toBe(7);
    expect(resolveKeep({ argv: ['--keep-rollbacks=1'], env: { ALYSIA_ROLLBACK_KEEP: '7' } })).toBe(1);
  });

  it('缺省/非法都退回 3', () => {
    expect(resolveKeep({} as never)).toBe(DEFAULT_KEEP);
    expect(resolveKeep({ argv: ['--keep-rollbacks=abc'], env: {} })).toBe(DEFAULT_KEEP);
    expect(resolveKeep({ argv: [], env: { ALYSIA_ROLLBACK_KEEP: '-3' } })).toBe(DEFAULT_KEEP);
  });

  it('允许 0（只留 latest）', () => {
    expect(resolveKeep({ argv: ['--keep-rollbacks=0'] })).toBe(0);
  });
});

describe('ROLLBACK_TAG_RE — 安全边界', () => {
  it('接受生产上真实出现过的标签形状', () => {
    for (const t of [
      'server-alysia:rollback-20261025-182610',
      'server-alysia:rollback-20261021-preimage',
      'server-alysia:rollback-20261017',
      'server-alysia:rollback-20261015-pre-reflection-fix',
    ]) {
      expect(ROLLBACK_TAG_RE.test(t)).toBe(true);
    }
  });

  it('拒绝 latest / 空后缀 / 注入', () => {
    for (const t of ['server-alysia:latest', 'server-alysia:rollback-', 'server-alysia:rollback-a;b', 'halo:2.20']) {
      expect(ROLLBACK_TAG_RE.test(t)).toBe(false);
    }
  });
});
