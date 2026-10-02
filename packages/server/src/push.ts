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
  /** 发送主动消息。返回是否成功（失败已由实现记日志） */
  sendProactive(openid: string, message: string): Promise<boolean>;
}

/** 无可用通道时的空实现 */
export const NO_PUSH_CHANNEL: PushChannel = {
  available: false,
  async sendProactive(): Promise<boolean> {
    return false;
  },
};
