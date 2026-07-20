import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry, ToolSet } from '../../src/tools/registry.js';
import type { ToolDefinition } from '../../src/tools/registry.js';

describe('ToolSet', () => {
  let toolSet: ToolSet;

  beforeEach(() => {
    toolSet = new ToolSet();
  });

  it('should start empty', () => {
    expect(toolSet.tools).toHaveLength(0);
    expect(toolSet.names()).toEqual([]);
  });

  it('should add a tool', () => {
    const tool: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: {
        type: 'object',
        properties: {
          msg: { type: 'string', description: 'A message' },
        },
        required: ['msg'],
      },
      handler: async () => 'ok',
    };
    toolSet.addTool(tool);
    expect(toolSet.tools).toHaveLength(1);
    expect(toolSet.names()).toEqual(['test_tool']);
  });

  it('should retrieve a tool by name', () => {
    const tool: ToolDefinition = {
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => 'sunny',
    };
    toolSet.addTool(tool);
    const found = toolSet.getTool('get_weather');
    expect(found).toBeDefined();
    expect(found!.name).toBe('get_weather');
    expect(toolSet.getTool('nonexistent')).toBeUndefined();
  });

  it('should convert to OpenAI tool format', () => {
    const tool: ToolDefinition = {
      name: 'search',
      description: 'Search web',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'query' },
        },
        required: ['q'],
      },
      handler: async () => 'results',
    };
    toolSet.addTool(tool);
    const openai = toolSet.toOpenAI();
    expect(openai).toHaveLength(1);
    expect(openai[0]).toEqual({
      type: 'function',
      function: {
        name: 'search',
        description: 'Search web',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string', description: 'query' } },
          required: ['q'],
        },
      },
    });
  });

  it('should return empty array when no tools added', () => {
    expect(toolSet.toOpenAI()).toEqual([]);
  });
});

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('should register and execute a tool', async () => {
    const tool: ToolDefinition = {
      name: 'hello',
      description: 'Say hello',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name' },
        },
        required: ['name'],
      },
      handler: async (args) => `Hello, ${args.name}!`,
    };
    registry.register(tool);
    const result = await registry.execute('hello', { name: 'World' });
    expect(result).toBe('Hello, World!');
  });

  it('should throw on unknown tool', async () => {
    await expect(registry.execute('unknown', {})).rejects.toThrow('Tool not found: unknown');
  });

  it('should convert to ToolSet with all registered tools', () => {
    const tool1: ToolDefinition = {
      name: 'a', description: '', parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => 'a',
    };
    const tool2: ToolDefinition = {
      name: 'b', description: '', parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => 'b',
    };
    registry.register(tool1);
    registry.register(tool2);
    const toolSet = registry.toToolSet();
    expect(toolSet.tools).toHaveLength(2);
    expect(toolSet.names()).toEqual(['a', 'b']);
  });

  it('should return empty ToolSet when no tools registered', () => {
    const toolSet = registry.toToolSet();
    expect(toolSet.tools).toHaveLength(0);
  });

  it('should support overwriting a tool with the same name', () => {
    const tool1: ToolDefinition = {
      name: 'x', description: 'original', parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => 'first',
    };
    const tool2: ToolDefinition = {
      name: 'x', description: 'updated', parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => 'second',
    };
    registry.register(tool1);
    registry.register(tool2);
    expect(registry.toToolSet().tools).toHaveLength(1);
  });

  // Backward compatibility: execute returns Promise<string>
  it('should return string from execute', async () => {
    const tool: ToolDefinition = {
      name: 'echo',
      description: 'Echo',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => 'echo!',
    };
    registry.register(tool);
    const result = await registry.execute('echo', {});
    expect(typeof result).toBe('string');
  });

  // Backward compatibility: toToolSet returns ToolSet
  it('should return ToolSet from toToolSet', () => {
    const result = registry.toToolSet();
    expect(result).toBeInstanceOf(ToolSet);
  });

  it('should execute tool handler with correct args', async () => {
    const handler = vi.fn().mockResolvedValue('done');
    const tool: ToolDefinition = {
      name: 'test',
      description: 'Test',
      parameters: { type: 'object', properties: {}, required: [] },
      handler,
    };
    registry.register(tool);
    await registry.execute('test', { key: 'value' });
    expect(handler).toHaveBeenCalledWith({ key: 'value' });
  });
});
