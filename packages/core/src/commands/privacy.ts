import type { CommandDefinition } from './registry.js';
import type { PrivacyMode } from '../memory/MemoryManager.js';

/**
 * `/privacy` 命令（★ 2026-10-25，change: `fulfill-privacy-mode`）
 *
 * 为什么要有它：spec §4.6 从 2026-08-02 起就写着「用户消息 `//privacy full|readonly|off`」，
 * 但**全仓没有这个命令处理器** —— 实际入口只有 `POST /api/privacy`，而 console 也没有 UI。
 * 一个只存在于 API、没有命令、没有界面的开关，等于不存在。
 *
 * ⚠️ 语法是 `/privacy <mode>`（单斜杠）：`CommandRegistry` 用 `rawText.slice(1).split(/\s+/)` 解析，
 * spec 里的双斜杠写法在这个注册表里永远匹配不到。
 */
export interface PrivacyCommandDeps {
  getMode: () => PrivacyMode;
  /** 返回**实际生效**的模式（设置失败时可能与入参不同） */
  setMode: (mode: PrivacyMode, sessionId: string) => PrivacyMode;
}

const LEGAL: PrivacyMode[] = ['off', 'readonly', 'full'];

/** 三档各做了什么 —— **回执必须说清，否则用户以为"隐私了"其实没有** */
function describe(mode: PrivacyMode): string {
  switch (mode) {
    case 'off':
      return '正常模式：照常记录，也照常引用。';
    case 'readonly':
      return '只读模式：这次对话**不会被她引用**（不进画像/人格/召回），但仍会存档（可审计，不参与学习）。';
    case 'full':
      return '隐身模式：这次对话**连存档都不写**。';
  }
}

export function createPrivacyCommand(deps: PrivacyCommandDeps): CommandDefinition {
  return {
    name: 'privacy',
    description: '切换隐私模式：/privacy off|readonly|full（会话结束后自动恢复 off）',
    aliases: ['p'],
    handler: async (event, args) => {
      const want = (args[0] ?? '').toLowerCase();
      const cur = deps.getMode();

      if (!want) {
        return `当前隐私模式：**${cur}** —— ${describe(cur)}\n用法：/privacy off|readonly|full`;
      }
      if (!LEGAL.includes(want as PrivacyMode)) {
        // 不静默忽略：说清合法值，并如实告知当前模式没变
        return `没有「${want}」这个模式。合法值：off / readonly / full（当前仍是 **${cur}**）`;
      }

      const applied = deps.setMode(want as PrivacyMode, event.unifiedMsgOrigin);
      const tail = applied === 'off' ? '会话结束后也会自动恢复 off。' : '会话结束后会自动恢复 off。';
      return `隐私模式已切到 **${applied}** —— ${describe(applied)}\n${tail}`;
    },
  };
}
