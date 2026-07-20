import type { MessageEvent } from '../platform/event.js';
import { MessageChain } from '../platform/chain.js';

export interface CommandDefinition {
  name: string;
  description: string;
  aliases?: string[];
  handler: (event: MessageEvent, args: string[]) => Promise<string | MessageChain>;
}

export class CommandRegistry {
  private commands: Map<string, CommandDefinition> = new Map();

  register(cmd: CommandDefinition): void {
    this.commands.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.commands.set(alias, cmd);
      }
    }
  }

  async execute(event: MessageEvent, rawText: string): Promise<string | null> {
    if (!rawText.startsWith('/')) return null;
    const parts = rawText.slice(1).split(/\s+/);
    const name = parts[0];
    const args = parts.slice(1);
    const cmd = this.commands.get(name);
    if (!cmd) return null;
    const result = await cmd.handler(event, args);
    return typeof result === 'string' ? result : result.getComponents().map(c => c.type === 'plain' ? (c as any).text : `[${c.type}]`).join('');
  }
}
