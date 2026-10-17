/**
 * 主动推送通道 —— 把「往某个 IM 会话主动发消息」这件事
 * 从具体的适配器类型上解耦出来。
 *
 * ★ 为什么需要它：`LifeService` / `ProactiveService` / 提醒推送原本各自持有一份
 *   `QQOfficialAgentAdapter`，但它们**只用到一个方法** `sendProactive`。
 *   持有整个适配器让这三者无法独立装配（也拖住了 dsh 迁移——
 *   见 `docs/dsh-plugin-architecture.md` §4.2）。
 *
 * 现状：由 `al:adapters` 模块提供；无 QQ 官方适配器时给出 `available: false` 的空实现，
 * 消费方据此跳过而不是拿到一个会炸的 `undefined`。
 */
export interface PushChannel {
  /** 是否有可用的推送通道。无通道时消费方应**跳过**主动推送（不是报错） */
  readonly available: boolean;
  /**
   * 发送主动消息。返回是否成功（失败已由实现记日志）。
   *
   * ★ 2026-10-18（change: `return-project-task-result`）：新增可选 `opts`。
   *   QQ 官方实现在**长文案或含换行**时会自动分段（≤3 段、段间 500-900ms 停顿，
   *   见 `qq-official.ts` 的 8-09 设计）。那对"她说话"是好的（像打字），
   *   对**通知**却是一条事拆成三条消息。工具类通知传 `maxSegments: 1` 即可。
   *   ⚠️ 可选参数 ⇒ 生活/问候/提醒三条既有调用**无需改动**。
   */
  sendProactive(openid: string, message: string, opts?: { maxSegments?: number }): Promise<boolean>;
}

/** 无可用通道时的空实现 */
export const NO_PUSH_CHANNEL: PushChannel = {
  available: false,
  async sendProactive(): Promise<boolean> {
    return false;
  },
};
