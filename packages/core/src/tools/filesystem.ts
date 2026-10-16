import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, realpathSync } from 'fs';
import { resolve, join, dirname, sep } from 'path';
import type { ToolDefinition } from './registry.js';

const MAX_READ_BYTES = 50_000;
const MAX_WRITE_BYTES = 100_000;
const MAX_LIST_FILES = 200;

/** Windows 上路径大小写不敏感（`realpathSync` 返回磁盘上的真实大小写，可能与入参不同） */
function norm(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * `target` 是否落在 `base` **之内**（含 base 自身）。
 *
 * ★ 第三批（2026-10-16）：必须**按路径段**比较，不能做字符串前缀。
 *   旧写法 `resolved.startsWith(resolve(base))` 会把**兄弟目录**也放行 ——
 *   `/work/ws-evil/x` 确实以 `/work/ws` 开头，但它**不在** ws 里。
 */
function isInside(base: string, target: string): boolean {
  const b = norm(base);
  const t = norm(target);
  if (t === b) return true;
  return t.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** `target` 自身或它**最近的已存在祖先**（给"待创建"的路径做软链检查用） */
function nearestExisting(target: string): string {
  let cur = target;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return target;   // 已到根
    cur = parent;
  }
  return cur;
}

function safePath(base: string, userPath: string): string {
  const baseResolved = resolve(base);
  const resolved = resolve(baseResolved, userPath);

  // ① 防路径穿越（`../..` 逃出工作区）——**按路径段**判，不是字符串前缀
  if (!isInside(baseResolved, resolved)) {
    throw new Error(`Path traversal blocked: "${userPath}" resolves outside workspace`);
  }

  // ② base 自身的真实路径（base 自己就可能是软链）
  let realBase = baseResolved;
  try { realBase = realpathSync(baseResolved); } catch { /* base 不存在：退回字面比较 */ }

  // ③ ★ 对**待创建**的路径也要查软链：查它**最近的已存在祖先**。
  //    旧实现把检查写在 `if (existsSync(resolved))` 里，而**待创建**的文件当然不存在
  //    ⇒ 直接 `return resolved` ⇒ 父目录若是软链/junction，写入会**真的落到工作区外**。
  let realAnchor: string;
  const anchor = nearestExisting(resolved);
  try { realAnchor = realpathSync(anchor); } catch { realAnchor = anchor; }
  if (!isInside(realBase, realAnchor)) {
    throw new Error(`Symlink traversal blocked: "${userPath}" points outside workspace`);
  }

  // ④ 目标已存在 → 返回**真实路径**（它本身可能是软链）
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    if (!isInside(realBase, real)) {
      throw new Error(`Symlink traversal blocked: "${userPath}" points outside workspace`);
    }
    return real;
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
