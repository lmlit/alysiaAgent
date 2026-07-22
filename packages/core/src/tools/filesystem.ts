import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { resolve, join, dirname } from 'path';
import type { ToolDefinition } from './registry.js';

const MAX_READ_BYTES = 50_000;
const MAX_WRITE_BYTES = 100_000;
const MAX_LIST_FILES = 200;

function safePath(base: string, userPath: string): string {
  const resolved = resolve(base, userPath);
  // 防止路径穿越 (../.. → 逃出 workspace)
  if (!resolved.startsWith(resolve(base))) {
    throw new Error(`Path traversal blocked: "${userPath}" resolves outside workspace`);
  }
  return resolved;
}

export function createWriteFileTool(workspaceDir: string): ToolDefinition {
  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }

  return {
    name: 'write_file',
    description: `Write a file to the workspace directory (${workspaceDir}).
Use this to save scripts, data, config files, or any content you need to persist.
Max file size: ${MAX_WRITE_BYTES} bytes.`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within workspace, e.g. "scripts/my_tool.sh" or "data/results.json"',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
    handler: async (args) => {
      const userPath = args.path as string;
      const content = args.content as string;

      if (content.length > MAX_WRITE_BYTES) {
        return `❌ Content too large (${content.length} bytes). Max: ${MAX_WRITE_BYTES} bytes.`;
      }

      try {
        const fullPath = safePath(workspaceDir, userPath);
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, content, 'utf-8');
        const size = Buffer.byteLength(content, 'utf-8');
        return `✅ File written: ${userPath} (${size} bytes)`;
      } catch (err: any) {
        return `❌ Failed to write file: ${err.message}`;
      }
    },
  };
}

export function createReadFileTool(workspaceDir: string): ToolDefinition {
  return {
    name: 'read_file',
    description: `Read a file from the workspace directory (${workspaceDir}).
Max read size: ${MAX_READ_BYTES} bytes.`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within workspace, e.g. "scripts/my_tool.sh"',
        },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const userPath = args.path as string;

      try {
        const fullPath = safePath(workspaceDir, userPath);
        if (!existsSync(fullPath)) {
          return `❌ File not found: ${userPath}`;
        }
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          return `❌ "${userPath}" is a directory, not a file. Use list_files instead.`;
        }
        if (stat.size > MAX_READ_BYTES) {
          return `❌ File too large (${stat.size} bytes). Max: ${MAX_READ_BYTES} bytes. First ${MAX_READ_BYTES} bytes:\n${readFileSync(fullPath, 'utf-8').slice(0, MAX_READ_BYTES)}`;
        }
        const content = readFileSync(fullPath, 'utf-8');
        return content || '(empty file)';
      } catch (err: any) {
        return `❌ Failed to read file: ${err.message}`;
      }
    },
  };
}

export function createListFilesTool(workspaceDir: string): ToolDefinition {
  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }

  return {
    name: 'list_files',
    description: `List files and directories in the workspace (${workspaceDir}).`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within workspace. Omit for root.',
        },
      },
      required: [],
    },
    handler: async (args) => {
      const userPath = (args.path as string) || '.';

      try {
        const fullPath = safePath(workspaceDir, userPath);
        if (!existsSync(fullPath)) {
          return `❌ Path not found: ${userPath}`;
        }
        const entries = readdirSync(fullPath).slice(0, MAX_LIST_FILES);
        const lines: string[] = [];
        for (const name of entries) {
          const p = join(fullPath, name);
          const s = statSync(p);
          const type = s.isDirectory() ? '📁' : '📄';
          const size = s.isFile() ? ` ${formatSize(s.size)}` : '';
          lines.push(`${type} ${name}${size}`);
        }
        if (entries.length === 0) {
          return '(empty directory)';
        }
        return lines.join('\n');
      } catch (err: any) {
        return `❌ Failed to list files: ${err.message}`;
      }
    },
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
