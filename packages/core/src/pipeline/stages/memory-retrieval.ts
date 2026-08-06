import type { Stage, PipelineContext } from '../types.js';
import type { MessageEvent } from '../../platform/event.js';
import type { MemoryManager } from '../../memory/MemoryManager.js';
import { logger } from '../../utils/logger.js';
import { localDateKey } from '../../memory/index.js';

/** ★ 消息时间标记（供短期记忆注入，让 AI 区分"今天/昨天"）。
 *  今天 → [HH:MM]；昨天 → [昨天 HH:MM]；更早 → [M月D日 HH:MM]。无时间戳 → ''。 */
export function fmtMsgTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const todayKey = localDateKey();
  const msgKey = localDateKey(d);
  const p = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (msgKey === todayKey) return `[${hhmm}]`;
  const yesterdayKey = localDateKey(new Date(Date.now() - 86_400_000));
  if (msgKey === yesterdayKey) return `[昨天 ${hhmm}]`;
  return `[${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}]`;
}

export class MemoryRetrievalStage implements Stage {
  constructor(private memoryManager: MemoryManager) {}

  async initialize(_ctx: PipelineContext): Promise<void> {}

  async process(event: MessageEvent): Promise<void> {
    const mode = event.pipelineMode;

    // ★ 主动调用 MemoryManager.read() 执行向量搜索 + Worldbook 匹配
    const readResult = await this.memoryManager.read({
      query: event.messageStr,
      mode,
      limit: 5,
    });

    // 写入类型安全的 extras 供下游 Stage 消费
    event.setExtra('search_results', readResult.retrieved);
    event.setExtra('worldbook_triggers', readResult.worldbook_triggers);

    // 组装长期记忆（Persona + Profile + vector results + Worldbook）
    const longTermMemory = await this.memoryManager.assembleWithWorldbook(
      mode,
      readResult.worldbook_triggers,
      readResult.retrieved,
    );

    // 短期记忆：EventLog 最近消息（24 小时窗口 + 最多 20 条，覆盖"今天+昨天"，
    // 注入带时间标记让 AI 区分天数；limit 20 防 token 膨胀）
    let recentContext = '';
    try {
      const recent = this.memoryManager.getRecentMessages(
        event.unifiedMsgOrigin, 20, new Date(Date.now() - 24 * 3600 * 1000),
      );
      if (recent.length > 0) {
        recentContext = recent.map(r => `${fmtMsgTime(r.createdAt)} ${r.content}`).join('\n');
      }
    } catch (err) {
      logger.warn('Failed to read recent messages from EventLog:', err);
    }

    const memoryContext = [longTermMemory, recentContext ? `\n## 最近对话\n${recentContext}` : '']
      .filter(Boolean)
      .join('\n');

    event.setExtra('memory_context', memoryContext);
  }
}
