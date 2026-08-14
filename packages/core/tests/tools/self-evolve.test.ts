// ★ 8-14 内容自进化工具（content-self-evolution）——工具形状 + 转发契约
import { describe, it, expect, vi } from 'vitest';
import { createSelfEvolveTools } from '../../src/tools/self-evolve';

function makeMm(overrides: Record<string, any> = {}) {
  return {
    addWorldbookEntry: vi.fn().mockResolvedValue({ ok: true, id: 'wb_self_x' }),
    listWorldbookEntries: vi.fn().mockReturnValue([
      { id: 'wb_self_1', triggerKeys: ['发光花'], content: '以前养过一盆会发光的花', source: 'self', createdAt: 't1' },
    ]),
    deleteWorldbookEntry: vi.fn().mockReturnValue(true),
    addLifeTemplate: vi.fn().mockResolvedValue({ ok: true, id: 'lt_self_x' }),
    listLifeTemplates: vi.fn().mockReturnValue([
      { id: 'lt_self_1', activity: '对着多肉发呆', type: 'internal', weight: 2, source: 'self' },
    ]),
    deleteLifeTemplate: vi.fn().mockReturnValue(true),
    ...overrides,
  } as any;
}

describe('createSelfEvolveTools', () => {
  it('注册 4 个工具，名字与参数形状正确', () => {
    const tools = createSelfEvolveTools(makeMm());
    const names = tools.map(t => t.name);
    expect(names).toEqual(['write_worldbook', 'add_life_template', 'delete_worldbook_entry', 'delete_life_template']);
    const wb = tools[0];
    expect(wb.parameters.required).toEqual(['trigger_keys', 'content']);
    // 行为准则硬约束
    expect(wb.description).toContain('只写关于你');
    expect(wb.description).toContain('不要汇报操作细节');
    // 删除工具：仅响应明确指令
    expect(tools[2].description).toContain('仅当用户明确要求删除时才调用');
    expect(tools[2].description).toContain('绝不可自主删除');
  });

  it('write_worldbook handler：转发 addWorldbookEntry（JSON 触发词解析）', async () => {
    const mm = makeMm();
    const [tool] = createSelfEvolveTools(mm);
    const result = await tool.handler({ trigger_keys: '["阳台","发光花"]', content: '以前养过一盆会发光的花' });
    expect(mm.addWorldbookEntry).toHaveBeenCalledWith({ triggerKeys: ['阳台', '发光花'], content: '以前养过一盆会发光的花' });
    expect(result).toContain('记下了');
  });

  it('write_worldbook 校验拒写 → 返回"这次不记了"', async () => {
    const mm = makeMm({ addWorldbookEntry: vi.fn().mockResolvedValue({ ok: false, reason: '内容模糊' }) });
    const [tool] = createSelfEvolveTools(mm);
    const result = await tool.handler({ trigger_keys: '["x"]', content: '模糊内容' });
    expect(result).toContain('这次不记了');
    expect(result).toContain('内容模糊');
  });

  it('delete_worldbook_entry：按关键词匹配删除（id/触发词/内容）', async () => {
    const mm = makeMm();
    const tools = createSelfEvolveTools(mm);
    const result = await tools[2].handler({ keyword: '发光' });
    expect(mm.deleteWorldbookEntry).toHaveBeenCalledWith('wb_self_1');
    expect(result).toContain('删掉了');
  });

  it('delete_worldbook_entry：无匹配 → 提示未找到，不删', async () => {
    const mm = makeMm();
    const tools = createSelfEvolveTools(mm);
    const result = await tools[2].handler({ keyword: '不存在的词' });
    expect(mm.deleteWorldbookEntry).not.toHaveBeenCalled();
    expect(result).toContain('没有找到');
  });

  it('add_life_template：type 默认 internal；显式 chat 透传', async () => {
    const mm = makeMm();
    const tools = createSelfEvolveTools(mm);
    await tools[1].handler({ activity: '对着多肉发呆' });
    expect(mm.addLifeTemplate).toHaveBeenCalledWith({ activity: '对着多肉发呆', type: 'internal' });
    await tools[1].handler({ activity: '在窗台种薄荷', type: 'chat' });
    expect(mm.addLifeTemplate).toHaveBeenCalledWith({ activity: '在窗台种薄荷', type: 'chat' });
  });

  it('delete_life_template：按关键词匹配删除', async () => {
    const mm = makeMm();
    const tools = createSelfEvolveTools(mm);
    const result = await tools[3].handler({ keyword: '多肉' });
    expect(mm.deleteLifeTemplate).toHaveBeenCalledWith('lt_self_1');
    expect(result).toContain('删掉了');
  });
});
