import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { ToolDefinition } from './registry.js';

const execAsync = promisify(exec);

const SHELL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 8_000;

// 禁止的危险命令模式（黑名单）
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,              // rm -rf /
  />\s*\/dev\/sd[a-z]/,         // 覆写磁盘
  /mkfs\./,                     // 格式化
  /dd\s+if=/,                   // dd 磁盘操作
  /:\(\)\s*\{/,                 // fork bomb
  /chmod\s+777\s+\//,           // chmod 777 /
  /sudo\s/,                     // 禁止 sudo
  /shutdown/,                   // 禁止关机
  /reboot/,                     // 禁止重启
  /systemctl/,                  // 禁止 systemd 操作
];

function isSafe(command: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked dangerous command pattern: ${pattern}`;
    }
  }
  return null;
}

export function createShellExecTool(workspaceDir: string): ToolDefinition {
  // 确保 workspace 目录存在
  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }

  return {
    name: 'shell_exec',
    description: `Execute a shell command in the workspace directory (${workspaceDir}).
Use this to: run scripts, install packages (pip/npm), fetch data with curl,
process files, or execute any command-line task.
Timeout: 30 seconds. Output truncated at ${MAX_OUTPUT_BYTES} bytes.
Dangerous commands (sudo, rm -rf /, mkfs, dd, shutdown, reboot) are blocked.`,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute. Use && to chain commands.',
        },
        explanation: {
          type: 'string',
          description: 'Brief explanation of what this command does (for safety audit)',
        },
      },
      required: ['command'],
    },
    handler: async (args) => {
      const command = args.command as string;
      const explanation = (args.explanation as string) || '(no explanation)';

      // 安全检查
      const blocked = isSafe(command);
      if (blocked) {
        return `❌ SAFETY BLOCK: ${blocked}\nCommand: ${command}\nExplanation: ${explanation}`;
      }

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workspaceDir,
          timeout: SHELL_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES * 4,
          shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
        });

        const result: string[] = [];

        if (stdout) {
          const truncated = stdout.length > MAX_OUTPUT_BYTES
            ? stdout.slice(0, MAX_OUTPUT_BYTES) + `\n... (truncated, ${stdout.length - MAX_OUTPUT_BYTES} more bytes)`
            : stdout;
          result.push(truncated);
        }

        if (stderr) {
          const truncated = stderr.length > MAX_OUTPUT_BYTES
            ? stderr.slice(0, MAX_OUTPUT_BYTES) + `\n... (truncated)`
            : stderr;
          result.push(`[stderr]\n${truncated}`);
        }

        if (!stdout && !stderr) {
          result.push('(command completed with no output)');
        }

        return result.join('\n') || '(no output)';
      } catch (err: any) {
        const killed = err.killed ? '\n⚠️ Command was killed (timeout or signal).' : '';
        const stderr = err.stderr ? `\n[stderr]\n${err.stderr.slice(0, MAX_OUTPUT_BYTES)}` : '';
        const stdout = err.stdout ? `\n[stdout]\n${err.stdout.slice(0, MAX_OUTPUT_BYTES)}` : '';
        return `❌ Command failed (exit code: ${err.code ?? 'unknown'}): ${err.message}${killed}${stdout}${stderr}`;
      }
    },
  };
}
